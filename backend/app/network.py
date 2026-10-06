"""Pin each HTTP connection to a validated public DNS answer, including redirects."""
import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit
import aiohttp
from aiohttp.abc import AbstractResolver


def validate_url(url):
    try:
        p = urlsplit(url)
        if p.scheme not in ('http','https') or not p.hostname or p.username or p.password or p.fragment:
            raise ValueError()
        _ = p.port
        host = p.hostname.lower().rstrip('.')
        if host in ('localhost',) or host.endswith(('.localhost','.local','.internal')):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address and not address.is_global:
            raise ValueError()
    except Exception:
        raise ValueError('Enter a public HTTP or HTTPS video URL without embedded credentials.')
    return url

class PublicResolver(AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        answers = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        result = []
        for fam, _, proto, _, sockaddr in answers:
            address = ipaddress.ip_address(sockaddr[0])
            if not address.is_global:
                raise ValueError('This URL resolves to a private or restricted network address.')
            result.append({'hostname':host, 'host':str(address), 'port':port,
                           'family':fam, 'proto':proto, 'flags':socket.AI_NUMERICHOST})
        if not result:
            raise ValueError('The video host could not be resolved.')
        return result
    async def close(self):
        pass

def connector():
    return aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
