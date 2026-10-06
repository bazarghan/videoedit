"""Pin each HTTP connection to a validated public DNS answer, including redirects."""

import asyncio
import ipaddress
import socket
import ssl
from urllib.parse import urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from python_socks import ProxyConnectionError, ProxyError, ProxyTimeoutError, ProxyType
from python_socks.async_.asyncio import Proxy


def validate_url(url):
    try:
        p = urlsplit(url)
        if (
            p.scheme not in ("http", "https")
            or not p.hostname
            or p.username
            or p.password
            or p.fragment
        ):
            raise ValueError()
        _ = p.port
        host = p.hostname.lower().rstrip(".")
        if host in ("localhost",) or host.endswith(
            (".localhost", ".local", ".internal")
        ):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address and not address.is_global:
            raise ValueError()
    except Exception:
        raise ValueError(
            "Enter a public HTTP or HTTPS video URL without embedded credentials."
        )
    return url


class PublicResolver(AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        answers = await asyncio.get_running_loop().getaddrinfo(
            host, port, type=socket.SOCK_STREAM
        )
        result = []
        for fam, _, proto, _, sockaddr in answers:
            address = ipaddress.ip_address(sockaddr[0])
            if not address.is_global:
                raise ValueError(
                    "This URL resolves to a private or restricted network address."
                )
            result.append(
                {
                    "hostname": host,
                    "host": str(address),
                    "port": port,
                    "family": fam,
                    "proto": proto,
                    "flags": socket.AI_NUMERICHOST,
                }
            )
        if not result:
            raise ValueError("The video host could not be resolved.")
        return result

    async def close(self):
        pass


class SocksConnector(aiohttp.TCPConnector):
    """Tunnel a pinned public IP while retaining aiohttp's original Host and TLS SNI."""

    def __init__(self, config):
        super().__init__(resolver=PublicResolver(), use_dns_cache=False)
        self.proxy_config = config

    async def _wrap_create_connection(
        self,
        *args,
        addr_infos,
        req,
        timeout,
        client_error=aiohttp.ClientConnectorError,
        **kwargs,
    ):
        address, port = addr_infos[0][4][:2]
        if not ipaddress.ip_address(address).is_global:
            raise ValueError(
                "This URL resolves to a private or restricted network address."
            )
        config = self.proxy_config
        proxy = Proxy(
            proxy_type=ProxyType.SOCKS5,
            host=config["host"],
            port=config["port"],
            username=config.get("username") or None,
            password=config.get("password") or None,
            rdns=False,
        )
        sock = None
        try:
            async with asyncio.timeout(timeout.sock_connect or timeout.connect or 30):
                sock = await proxy.connect(
                    dest_host=address, dest_port=port, timeout=30
                )
                connection = await self._loop.create_connection(
                    *args, **kwargs, sock=sock
                )
                sock = None  # Ownership transferred to the transport.
                return connection
        except (ProxyConnectionError, ProxyTimeoutError, ProxyError):
            raise ValueError(
                "The SOCKS5 proxy could not connect or rejected authentication. Check its address, port and credentials, then retry."
            ) from None
        except ssl.CertificateError as exc:
            raise aiohttp.ClientConnectorCertificateError(
                req.connection_key, exc
            ) from exc
        except ssl.SSLError as exc:
            raise aiohttp.ClientConnectorSSLError(req.connection_key, exc) from exc
        except OSError as exc:
            raise client_error(req.connection_key, exc) from exc
        finally:
            if sock is not None:
                sock.close()


def connector(proxy=None):
    if proxy:
        return SocksConnector(proxy)
    return aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
