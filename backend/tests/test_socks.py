import asyncio
import ipaddress
import socket
import ssl
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import aiohttp
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient

from app import main, store as s, workers
from app.network import connector


@asynccontextmanager
async def socks_fixture(auth=False):
    """A real SOCKS5 handshake and byte relay, scoped to local test servers."""
    attempts, tunnels, tasks = [], [], set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        tasks.add(task)
        upstream = None
        try:
            version, length = await reader.readexactly(2)
            assert version == 5
            methods = await reader.readexactly(length)
            method = 2 if auth else 0
            assert method in methods
            writer.write(bytes([5, method]))
            await writer.drain()
            if auth:
                version, length = await reader.readexactly(2)
                username = await reader.readexactly(length)
                length = (await reader.readexactly(1))[0]
                password = await reader.readexactly(length)
                attempts.append((username, password))
                accepted = username == b"tester" and password == b"proxy-secret"
                writer.write(bytes([1, 0 if accepted else 1]))
                await writer.drain()
                if not accepted:
                    return
            version, command, _, kind = await reader.readexactly(4)
            assert version == 5 and command == 1
            # Pinning must send an IP address, never a remotely resolved domain.
            assert kind in (1, 4)
            address = str(
                ipaddress.ip_address(await reader.readexactly(4 if kind == 1 else 16))
            )
            port = int.from_bytes(await reader.readexactly(2), "big")
            assert address == "1.1.1.1"
            tunnels.append((address, port))
            source, upstream = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
            await writer.drain()

            async def relay(src, dst):
                while data := await src.read(65536):
                    dst.write(data)
                    await dst.drain()

            pair = [
                asyncio.create_task(relay(reader, upstream)),
                asyncio.create_task(relay(source, writer)),
            ]
            try:
                await asyncio.wait(pair, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for child in pair:
                    child.cancel()
                await asyncio.gather(*pair, return_exceptions=True)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            if upstream:
                upstream.close()
            writer.close()
            tasks.discard(task)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    config = {"host": "127.0.0.1", "port": server.sockets[0].getsockname()[1]}
    if auth:
        config.update(username="tester", password="proxy-secret")
    try:
        yield config, attempts, tunnels
    finally:
        server.close()
        await server.wait_closed()
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*list(tasks), return_exceptions=True)


def public_dns(monkeypatch):
    loop = asyncio.get_running_loop()
    original = loop.getaddrinfo

    async def lookup(host, port, **kwargs):
        if host.endswith(".example"):
            addresses = (
                ["1.1.1.1", "127.0.0.1"] if host == "blocked.example" else ["1.1.1.1"]
            )
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))
                for address in addresses
            ]
        return await original(host, port, **kwargs)

    monkeypatch.setattr(loop, "getaddrinfo", lookup)


def tls_contexts(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "download.example")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("download.example"), x509.DNSName("cdn.example")]
            ),
            False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert_path, key_path)
    client = ssl.create_default_context(cafile=str(cert_path))
    return server, client


@pytest.mark.parametrize("auth", [False, True])
@pytest.mark.parametrize("https", [False, True])
def test_socks_download_redirect_signed_query_and_tls(
    monkeypatch, tmp_path, auth, https
):
    async def scenario():
        public_dns(monkeypatch)
        requested, host_headers, names = [], [], []
        server_ssl, client_ssl = tls_contexts(tmp_path) if https else (None, None)
        if server_ssl:
            server_ssl.set_servername_callback(
                lambda sock, name, context: names.append(name)
            )
        scheme = "https" if https else "http"
        video = b"test-media-through-socks" * 5000

        async def http(reader, writer):
            try:
                headers = (await reader.readuntil(b"\r\n\r\n")).decode()
                route = headers.split(" ")[1]
                requested.append(route)
                host_headers.append(
                    next(
                        line
                        for line in headers.split("\r\n")
                        if line.startswith("Host:")
                    )
                )
                if route == "/start":
                    reply = f"HTTP/1.1 302 Found\r\nLocation: {scheme}://cdn.example:{port}/video.mp4?token=a%2Fb&signature=z%2B1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
                else:
                    reply = (
                        f"HTTP/1.1 200 OK\r\nContent-Length: {len(video)}\r\nConnection: close\r\n\r\n".encode()
                        + video
                    )
                writer.write(reply)
                await writer.drain()
            finally:
                writer.close()

        server = await asyncio.start_server(http, "127.0.0.1", 0, ssl=server_ssl)
        port = server.sockets[0].getsockname()[1]
        pid, ident = s.uid(), None
        try:
            async with socks_fixture(auth) as (config, attempts, tunnels):

                def trusted_connector(proxy=None):
                    result = connector(proxy)
                    if client_ssl:
                        result._ssl = client_ssl
                    return result

                monkeypatch.setattr(workers, "connector", trusted_connector)
                monkeypatch.setattr(workers.media, "ingest", AsyncMock())
                payload = {
                    "url": f"{scheme}://download.example:{port}/start",
                    "proxy": config,
                }
                ident = s.job("download", pid, payload)
                await workers.download(pid, payload, ident)
                assert (s.DATA / "sources" / (pid + ".media")).read_bytes() == video
                assert requested == ["/start", "/video.mp4?token=a%2Fb&signature=z%2B1"]
                assert host_headers == [
                    f"Host: download.example:{port}",
                    f"Host: cdn.example:{port}",
                ]
                assert tunnels == [("1.1.1.1", port)] * 2
                if auth:
                    assert attempts == [(b"tester", b"proxy-secret")] * 2
                if https:
                    assert names == ["download.example", "cdn.example"]
                raw = s.one("SELECT payload FROM jobs WHERE id=?", (ident,))["payload"]
                assert "proxy-secret" not in raw and "signature=" not in raw
        finally:
            server.close()
            await server.wait_closed()
            (s.DATA / "sources" / (pid + ".media")).unlink(missing_ok=True)
            if ident:
                s.execute("DELETE FROM jobs WHERE id=?", (ident,))

    asyncio.run(scenario())


def test_socks_rejects_private_dns_auth_failure_and_cancellation(monkeypatch):
    async def scenario():
        public_dns(monkeypatch)
        async with socks_fixture(True) as (config, attempts, tunnels):
            async with aiohttp.ClientSession(connector=connector(config)) as client:
                with pytest.raises(ValueError, match="restricted"):
                    await client.get("http://blocked.example/video.mp4")
                with pytest.raises(ValueError, match="restricted"):
                    await client.get("http://127.0.0.1/video.mp4")
            assert not tunnels and not attempts
            wrong = {**config, "password": "wrong-secret"}
            async with aiohttp.ClientSession(connector=connector(wrong)) as client:
                with pytest.raises(ValueError, match="SOCKS5 proxy") as error:
                    await client.get("http://download.example/video.mp4")
            assert "wrong-secret" not in str(error.value) and not tunnels

        connected, closed = asyncio.Event(), asyncio.Event()

        async def stalled(reader, writer):
            connected.set()
            try:
                await reader.read()  # Drain greeting and wait until client closes.
            finally:
                writer.close()
                closed.set()

        server = await asyncio.start_server(stalled, "127.0.0.1", 0)
        config = {"host": "127.0.0.1", "port": server.sockets[0].getsockname()[1]}
        pid = s.uid()
        payload = {"url": "http://download.example/video.mp4", "proxy": config}
        ident = s.job("download", pid, payload)
        try:
            task = asyncio.create_task(workers.download(pid, payload, ident))
            await asyncio.wait_for(connected.wait(), 3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(closed.wait(), 3)
            assert not (s.DATA / "sources" / (pid + ".part")).exists()
        finally:
            server.close()
            await server.wait_closed()
            s.execute("DELETE FROM jobs WHERE id=?", (ident,))

    asyncio.run(scenario())


def test_proxy_profile_credentials_and_job_snapshot(monkeypatch):
    async def idle(*args):
        await asyncio.Event().wait()

    monkeypatch.setattr(main, "worker", idle)
    with TestClient(main.app) as client:
        assert client.get("/api/settings/download-proxy").status_code == 401
        client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password-do-not-use"},
        )
        config = {
            "host": "proxy.example",
            "port": 1080,
            "username": "tester",
            "password": "private-proxy-password",
        }
        endpoint = "/api/settings/download-proxy"
        assert (
            client.post(
                "/api/import/url",
                json={"url": "https://example.com/video.mp4", "use_proxy": True},
            ).status_code
            == 400
        )
        reply = client.put(endpoint, json=config)
        assert reply.status_code == 200
        assert reply.json()["password_saved"] and "password" not in reply.json()
        assert config["password"] not in client.get(endpoint).text
        invalid = client.put(endpoint, json={**config, "port": 0})
        assert invalid.status_code == 422 and config["password"] not in invalid.text
        assert (
            client.put(
                endpoint, json={**config, "host": "socks5://bad:1080"}
            ).status_code
            == 422
        )
        assert client.put(endpoint, json={**config, "password": ""}).json()[
            "password_saved"
        ]
        assert s.setting("download_proxy")["password"] == config["password"]
        queued = client.post(
            "/api/import/url",
            json={"url": "https://example.com/video.mp4", "use_proxy": True},
        ).json()
        direct = client.post(
            "/api/import/url", json={"url": "https://example.com/direct.mp4"}
        ).json()
        raw = s.one("SELECT payload FROM jobs WHERE id=?", (queued["job_id"],))[
            "payload"
        ]
        assert s.decrypt(raw)["proxy"] == config
        assert "proxy" not in s.decrypt(
            s.one("SELECT payload FROM jobs WHERE id=?", (direct["job_id"],))["payload"]
        )
        assert config["password"] not in client.get("/api/jobs").text
        assert (
            config["password"]
            not in s.one("SELECT value FROM settings WHERE key='download_proxy'")[
                "value"
            ]
        )
        assert (
            client.put(
                endpoint, json={**config, "password": "", "clear_password": True}
            ).json()["password_saved"]
            is False
        )
        client.put(endpoint, json=config)
        assert (
            client.put(endpoint, json={**config, "port": 1081, "password": ""}).json()[
                "password_saved"
            ]
            is False
        )
        client.delete(endpoint)
        assert client.get(endpoint).json()["host"] == ""
        assert s.decrypt(raw)["proxy"]["password"] == config["password"]
        for result in (queued, direct):
            assert (
                client.post(f"/api/jobs/{result['job_id']}/cancel").status_code == 200
            )
            # The idle substitute has no process to stop; age the cancellation grace period.
            s.update_job(result["job_id"], finished=0)
            assert (
                client.delete(f"/api/projects/{result['project_id']}").status_code
                == 200
            )
