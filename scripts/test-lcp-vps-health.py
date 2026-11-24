#!/usr/bin/env python3
"""Hermetic supervisor regressions. Never starts/stops live services."""
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("lcp_vps_health", pathlib.Path(__file__).with_name("lcp-vps-health.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)
METRIC = "commands_poll_last_successful_timestamp_seconds"

class HealthTests(unittest.TestCase):
    def test_poll_requires_single_recent_timestamp(self):
        for text, expected in [
            (METRIC + '{scope="controlplane"} 1.000e3\n', True),
            (METRIC + " 880\n", True),
            (METRIC + " 879\n", False),
            (METRIC + " 1006\n", False),
            (METRIC + " NaN\n", False),
            (METRIC + " 0\n", False),
            ("# HELP " + METRIC + " poll time", False),
            (METRIC + " 1000\n" + METRIC + " 1000\n", False),
            (METRIC + "\n1000\n", False),
        ]:
            with self.subTest(text=text):
                self.assertEqual(health.fresh_poll(text, 1000), expected)

    def test_mcp_oauth_required_and_false_ready_rejected(self):
        with patch.object(health, "get", return_value='{"status":"ok","authMode":"token"}'):
            self.assertFalse(health.mcp_ready())
        with patch.object(health, "get", side_effect=[
            '{"status":"ok","authMode":"oauth"}', "not ready"
        ]):
            self.assertFalse(health.tunnel_ready())

    def test_readyz_without_poll_is_not_healthy(self):
        with patch.object(health, "get", side_effect=[
            '{"status":"ok","authMode":"oauth"}', "ready", "# no poller"
        ]):
            self.assertFalse(health.tunnel_ready())
        with patch.object(health.time, "time", return_value=1000), patch.object(
            health, "get", side_effect=['{"status":"ok","authMode":"oauth"}', "ready", METRIC + " 999"]
        ):
            self.assertTrue(health.tunnel_ready())

    def run_supervisor(self, states, clock, *, mcp=True, child=None, stop=False):
        child = child or Mock()
        child.poll.return_value = None
        handlers = {}
        def signal_handler(sig, handler):
            handlers[sig] = handler
        def sleep(_seconds):
            if stop:
                handlers[health.signal.SIGTERM](None, None)
        with patch.object(health, "wait_ready", return_value=mcp), patch.object(
            health, "tunnel_ready", side_effect=states
        ), patch.object(health.time, "monotonic", side_effect=clock), patch.object(
            health.time, "sleep", side_effect=sleep
        ), patch.object(health.signal, "signal", side_effect=signal_handler), patch.object(
            health.subprocess, "Popen", return_value=child
        ) as spawn:
            result = health.supervise(["synthetic-tunnel"])
        return result, spawn, child

    def test_backend_not_ready_never_launches_tunnel(self):
        result, spawn, _ = self.run_supervisor([], [], mcp=False)
        self.assertEqual(result, 1)
        spawn.assert_not_called()

    def test_startup_disabled_polling_exits_and_reaps_child(self):
        result, spawn, child = self.run_supervisor([False, False], [0, 1, 76])
        self.assertEqual(result, 1)
        spawn.assert_called_once_with(["synthetic-tunnel"])
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=10)

    def test_runtime_health_failure_debounced_and_child_reaped(self):
        result, _, child = self.run_supervisor([True, False, True, False, False, False], [0])
        self.assertEqual(result, 1)
        child.terminate.assert_called_once()

    def test_explicit_stop_exits_cleanly(self):
        result, _, child = self.run_supervisor([True], [0], stop=True)
        self.assertEqual(result, 0)
        child.terminate.assert_called_once()

    def test_child_ignores_term_is_killed(self):
        child = Mock()
        child.wait.side_effect = [health.subprocess.TimeoutExpired("synthetic", 10), 0]
        result, _, child = self.run_supervisor([True], [0], child=child, stop=True)
        self.assertEqual(result, 0)
        child.kill.assert_called_once()
        self.assertEqual(child.wait.call_count, 2)

if __name__ == "__main__":
    unittest.main(verbosity=2)
