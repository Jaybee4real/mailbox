"""Keep working when the router's resolver flaps.

A home router whose resolver drops takes every request with it while raw IP
connectivity is fine. Installing this makes any failed lookup fall back to asking
1.1.1.1 by address over HTTPS, which needs no working resolver to reach.

import-mbox.py carries its own copy of this; it is left alone deliberately while it
is mid-import, and can be pointed here once it is idle.
"""
import json
import socket
import urllib.parse
import urllib.request

_cache = {}
_system_getaddrinfo = socket.getaddrinfo


def _lookup(host):
    request = urllib.request.Request(
        f'https://1.1.1.1/dns-query?name={urllib.parse.quote(host)}&type=A',
        headers={'accept': 'application/dns-json'},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        answers = json.load(response).get('Answer') or []
    addresses = [entry['data'] for entry in answers if entry.get('type') == 1]
    if not addresses:
        raise socket.gaierror(f'no A record for {host} via DoH')
    return addresses


def _resilient(host, port, family=0, kind=0, proto=0, flags=0):
    try:
        return _system_getaddrinfo(host, port, family, kind, proto, flags)
    except socket.gaierror:
        if host == '1.1.1.1' or not isinstance(host, str):
            raise
        if host not in _cache:
            _cache[host] = _lookup(host)
            print(f'  ~ system DNS failed for {host}; using DoH answer {_cache[host][0]}', flush=True)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (address, port))
                for address in _cache[host]]


def install():
    socket.getaddrinfo = _resilient
