#!/usr/bin/python3 -I
"""Loopback-only readiness and tunnel supervision for the Aruba systemd deployment."""
import argparse
import json
import math
import re
import signal
import subprocess
import sys
import time
import http.client
from urllib.parse import urlsplit

MCP = "http://127.0.0.1:8766"
TUNNEL = "http://127.0.0.1:8790"
POLL_MAX_AGE = 120
# Direct loopback connection, without proxies or redirects.
def get(url):
    target = urlsplit(url)
    conn = http.client.HTTPConnection(target.hostname, target.port, timeout=3)
    try:
        conn.request("GET", target.path)
        with conn.getresponse() as response:
            if response.status != 200:
                raise ValueError("unexpected HTTP status")
            return response.read(2 * 1024 * 1024).decode("utf-8")
    finally:
        conn.close()

def fresh_poll(metrics, now):
    rows = re.findall(r"^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?[ \t]+(\S+)[ \t]*$", metrics, re.M)
    if len(rows) != 1:
        return False
    try:
        age = now - float(rows[0])
        return math.isfinite(age) and -5 <= age <= POLL_MAX_AGE
    except ValueError:
        return False

def mcp_ready():
    try:
        value = json.loads(get(MCP + "/health"))
        return value.get("status") == "ok" and value.get("authMode") == "oauth"
    except (OSError, ValueError, AttributeError, http.client.HTTPException):
        return False

def tunnel_ready():
    try:
        return (mcp_ready() and
                bool(re.match(r"^(ready|ok)\b", get(TUNNEL + "/readyz").strip(), re.I)) and
                fresh_poll(get(TUNNEL + "/metrics"), time.time()))
    except (OSError, ValueError, http.client.HTTPException):
        return False

def wait_ready(probe, timeout):
    deadline = time.monotonic() + timeout
    while True:
        if probe():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(1)

def supervise(command):
    # systemd owns this process and the complete child cgroup. Do not detach.
    child = None
    stopping = False
    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        if not wait_ready(lambda: stopping or mcp_ready(), 60):
            print("MCP readiness deadline exceeded", file=sys.stderr, flush=True)
            return 1
        if stopping:
            return 0
        child = subprocess.Popen(command)
        startup_deadline = time.monotonic() + 75
        ready_once = False
        misses = 0
        while not stopping:
            if child.poll() is not None:
                print("Tunnel child exited", file=sys.stderr, flush=True)
                return 1
            if tunnel_ready():
                if not ready_once:
                    print("Tunnel ready; OpenAI polling confirmed", flush=True)
                ready_once = True
                misses = 0
            else:
                misses += 1
                if (not ready_once and time.monotonic() >= startup_deadline) or (ready_once and misses >= 3):
                    print("Tunnel unhealthy; exiting for systemd recovery", file=sys.stderr, flush=True)
                    return 1
            # Short sleep slices make SIGTERM responsive.
            for _ in range(10 if ready_once else 2):
                if stopping:
                    break
                time.sleep(1)
        return 0
    finally:
        if child is not None and child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["mcp", "tunnel", "wait-mcp", "wait-tunnel", "supervise"])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "supervise":
        command = args.command
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            parser.error("supervise needs a child command")
        return supervise(command)
    if args.command:
        parser.error("unexpected arguments")
    if args.action == "mcp":
        ok = mcp_ready()
    elif args.action == "tunnel":
        ok = tunnel_ready()
    else:
        ok = wait_ready(mcp_ready if args.action == "wait-mcp" else tunnel_ready, 60 if args.action == "wait-mcp" else 150)
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
