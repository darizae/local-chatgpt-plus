#!/usr/bin/python3
"""Hermetic tests: no live services, network calls, or paid model jobs."""
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent
def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(ROOT / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

queue = load("lcp-agent-queue")
broker = load("lcp-agent-queue-broker")
launcher = load("lcp-native-subagent")
maintenance = load("lcp-maintenance")

NOW = 100000
def job(created=NOW - 100, engine="omp", state="completed", cost=0.05):
    return {"created": created, "engine": engine, "state": state, "max_cost_usd": cost}

class QueueTests(unittest.TestCase):
    def test_no_rolling_job_or_cost_quota(self):
        jobs = [job(state="completed", cost=5)] * 1000 + [job(state="failed", cost=5)] * 100
        queue.check_capacity(jobs, queue.DEFAULT_POLICY, "omp", 5, NOW)
        state = queue.capacity(jobs, queue.DEFAULT_POLICY, NOW)
        self.assertEqual(state["model_jobs_24h"], 1100)
        self.assertEqual(state["reserved_cost_usd_24h"], 5500)
        self.assertIsNone(state["max_model_jobs_24h"])
        self.assertIsNone(state["max_reserved_cost_usd_24h"])

    def test_legacy_policy_cannot_restore_rolling_quotas(self):
        policy = {"max_queued_jobs": 32, "max_model_jobs_24h": 1, "max_reserved_cost_usd_24h": 0.01}
        queue.check_capacity([job(cost=5)] * 100, policy, "omp", 5, NOW)
        state = queue.capacity([], policy, NOW)
        self.assertIsNone(state["max_model_jobs_24h"])
        self.assertIsNone(state["max_reserved_cost_usd_24h"])

    def test_only_inflight_queue_backpressure_remains(self):
        policy = queue.DEFAULT_POLICY
        queue.check_capacity([job(state="queued")] * 31, policy, "omp", 5, NOW)
        with self.assertRaises(queue.QueueRejected) as ctx:
            queue.check_capacity([job(state="queued")] * 32, policy, "selftest", 0.05, NOW)
        self.assertEqual(ctx.exception.code, "queue_full")

    def test_broker_increased_cost_runtime_and_prompt(self):
        req = {"action":"submit","repo":"example","prompt":"a"*24000,"seconds":1800,"cost":5,"engine":"omp"}
        result = {"id":"a"*32,"state":"queued","base_commit":"b"*40,"parent_dirty":True}
        with patch.object(broker, "queue_call", return_value=json.dumps(result)) as call:
            reply = broker.dispatch(req)
            self.assertEqual(reply["max_cost_usd"], 5)
            self.assertEqual(reply["seconds"], 1800)
            self.assertTrue(reply["parent_dirty"])
            self.assertEqual(reply["base_commit"], "b"*40)
            self.assertIn("5", call.call_args.args[0])
        for invalid in [{"cost":5.01},{"seconds":1801},{"prompt":"a"*24001}]:
            with self.assertRaises(ValueError):
                broker.dispatch({**req,**invalid})

    def test_dirty_repository_admitted_at_pinned_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            projects = root / "projects"
            repo = projects / "example"
            (repo / ".git").mkdir(parents=True)
            tasks = root / "tasks"
            tasks.mkdir()
            args = MagicMock(engine="omp",seconds=900,cost=1,repo="example")
            head = subprocess.CompletedProcess([], 0, "b"*40 + "\n", "")
            status = subprocess.CompletedProcess([], 0, " M file.txt\n", "")
            with patch.object(queue,"PROJECTS",projects), patch.object(queue,"TASKS",tasks), patch.object(queue,"LOCK",tasks/".lock"), patch.object(queue,"git",side_effect=[head,status]), patch.object(queue,"load_policy",return_value=queue.DEFAULT_POLICY), patch.object(queue.sys,"stdin",io.StringIO("review")), patch.object(queue.sys,"stdout",io.StringIO()) as stdout:
                queue.submit(args)
                receipt = json.loads(stdout.getvalue())
            self.assertTrue(receipt["parent_dirty"])
            self.assertEqual(receipt["base_commit"], "b"*40)
            state = json.loads((tasks / receipt["id"] / "state.json").read_text())
            self.assertEqual(state["base_commit"], "b"*40)
            self.assertTrue(state["parent_dirty"])

    def test_broker_only_reflects_allowlisted_reason(self):
        response = subprocess.CompletedProcess([], 2, stdout=json.dumps({"code":"daily_job_limit","retry_after_seconds":42}), stderr="SECRET")
        with patch.object(broker.subprocess, "run", return_value=response):
            with self.assertRaises(broker.QueueRejected) as ctx:
                broker.queue_call(["submit"])
        self.assertEqual(ctx.exception.code, "daily_job_limit")
        self.assertEqual(ctx.exception.retry, 42)
        self.assertNotIn("SECRET", str(ctx.exception))
        response.stdout = json.dumps({"code":"secret raw diagnostic","retry_after_seconds":"secret"})
        with patch.object(broker.subprocess, "run", return_value=response):
            with self.assertRaises(broker.QueueRejected) as ctx:
                broker.queue_call(["submit"])
        self.assertEqual(ctx.exception.code, "queue_rejected")
        self.assertIsNone(ctx.exception.retry)

    def test_capacity_no_submission(self):
        result = queue.capacity([job()] * 4, queue.DEFAULT_POLICY, NOW)
        with patch.object(broker, "queue_call", return_value=json.dumps(result)) as call:
            response = broker.dispatch({"action":"capacity"})
            self.assertEqual(response["model_jobs_24h"], 4)
            self.assertIsNone(response["max_model_jobs_24h"])
            self.assertIsNone(response["max_reserved_cost_usd_24h"])
            self.assertEqual(response["max_job_cost_usd"], 5)
            call.assert_called_once_with(["capacity"])
        with self.assertRaises(ValueError):
            broker.dispatch({"action":"capacity","repo":"anything"})

    def test_native_launcher_propagates_reason(self):
        response = {"ok":False,"code":"daily_job_limit","retry_after_seconds":42,"error":"do not repeat raw text"}
        conn = MagicMock()
        conn.__enter__.return_value = conn
        stream = MagicMock()
        stream.__enter__.return_value = stream
        stream.readline.return_value = (json.dumps(response)+"\n").encode()
        conn.makefile.return_value = stream
        with patch.object(launcher.socket, "socket", return_value=conn):
            with self.assertRaisesRegex(ValueError, "SAIA job quota exhausted; earliest quota release in 42 seconds"):
                launcher.ask({"action":"submit"})

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(maintenance, "STATE", pathlib.Path(self.temp.name))
        self.patch.start()
        self.req = {"action":"restart","commit":"012345abcdef","receipt":"a"*32}

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_rejects_arbitrary_commands_and_fields(self):
        for bad in [
            {"action":"shell","command":"id"},
            {"action":"restart","commit":"; id","receipt":"a"*32},
            {**self.req,"command":"id"},
            {**self.req,"service":"ssh.service"},
            {"action":"status","path":"/etc/shadow"},
        ]:
            with self.assertRaises(ValueError):
                maintenance.validate(bad)
        maintenance.validate(self.req)
        maintenance.validate({"action":"status"})

    def test_restart_ack_before_fixed_controller_and_verify(self):
        replies = []
        before = {"ActiveState":"active","MainPID":"101"}
        after = {"ActiveState":"active","MainPID":"102"}
        def controller(*args):
            self.assertEqual(args, (maintenance.CONTROLLER, "apply", "restart"))
            self.assertEqual(replies[0]["state"], "accepted")
            return subprocess.CompletedProcess(args, 0)
        with patch.object(maintenance, "unit", side_effect=[before,before,after,after]), patch.object(maintenance,"call",side_effect=controller) as run, patch.object(maintenance,"current_health",return_value=(self.req["commit"],"run-2")):
            maintenance.restart(self.req, replies.append)
        self.assertEqual(maintenance.read_state()["state"],"completed")
        self.assertEqual(maintenance.read_state()["runtime_commit"],self.req["commit"])
        run.assert_called_once()
        with patch.object(maintenance,"call") as run:
            maintenance.restart(self.req, replies.append)
            run.assert_not_called()
        self.assertEqual(replies[-1]["state"],"completed")

    def test_explicit_off_not_reenabled(self):
        replies = []
        with patch.object(maintenance,"unit",return_value={"ActiveState":"inactive","MainPID":"0"}), patch.object(maintenance,"call") as run:
            maintenance.restart(self.req,replies.append)
            run.assert_not_called()
        self.assertEqual(replies,[{"ok":False,"code":"service_not_on"}])

    def test_stale_artifact_fails_verification(self):
        before={"ActiveState":"active","MainPID":"101"}
        after={"ActiveState":"active","MainPID":"102"}
        with patch.object(maintenance,"unit",side_effect=[before,before,after,after]), patch.object(maintenance,"call"), patch.object(maintenance,"current_health",return_value=("badbadbadbad","run")):
            maintenance.restart(self.req, lambda value: None)
        self.assertEqual(maintenance.read_state()["state"],"failed")

if __name__ == "__main__":
    unittest.main(verbosity=2)
