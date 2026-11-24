#!/usr/bin/python3
import importlib.machinery
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.dont_write_bytecode=True
loader=importlib.machinery.SourceFileLoader("broker",str(pathlib.Path(__file__).with_name("lcp-git-push-broker")))
spec=importlib.util.spec_from_loader(loader.name,loader)
broker=importlib.util.module_from_spec(spec)
loader.exec_module(broker)

class GitTests(unittest.TestCase):
    def test_main_dirty_new_repo_with_account_credential(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            repo=root/"arbitrary-checkout"
            repo.mkdir()
            def git(*args):
                return subprocess.check_output(["/usr/bin/git","-C",str(repo),*args],text=True).strip()
            git("init","-b","main")
            git("config","user.name","Fixture")
            git("config","user.email","fixture@example.invalid")
            git("remote","add","origin","https://github.com/example/new-repo.git")
            (repo/"asset.bin").write_bytes(b"\x00"*1000+b"ordinary asset")
            git("add","asset.bin")
            git("commit","-m","asset")
            (repo/"dirty.txt").write_text("uncommitted")
            with patch.object(broker,"PROJECTS",root), patch.object(broker,"policy",return_value=("example",{},"authorized_key")):
                self.assertEqual(broker.workspace(str(repo))[1:],("new-repo","main","example","authorized_key"))
            broker.inspect_outgoing(repo,[])
            # A secret-like private path in an earlier outgoing commit is rejected
            # even after the file is deleted in the latest commit.
            (repo/".env").write_text("fixture only")
            git("add",".env")
            git("commit","-m","fixture")
            git("rm",".env")
            git("commit","-m","remove fixture")
            with self.assertRaisesRegex(ValueError,"sensitive committed path"):
                broker.inspect_outgoing(repo,[])
    def test_origin_scope(self):
        self.assertEqual(broker.origin_repo("git@github.com:example/abc.git","example"),"abc")
        with self.assertRaises(ValueError): broker.origin_repo("https://github.com/other/abc.git","example")
    def test_missing_credential_still_denied(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            repo=root/"repo"
            repo.mkdir()
            subprocess.run(["/usr/bin/git","-C",str(repo),"init","-b","main"],check=True,capture_output=True)
            subprocess.run(["/usr/bin/git","-C",str(repo),"remote","add","origin","https://github.com/example/abc.git"],check=True)
            with patch.object(broker,"PROJECTS",root),patch.object(broker,"policy",return_value=("example",{},None)):
                with self.assertRaisesRegex(ValueError,"credential not provisioned"):
                    broker.workspace(str(repo))
if __name__=="__main__": unittest.main(verbosity=2)
