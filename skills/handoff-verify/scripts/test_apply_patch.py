#!/usr/bin/env python3
"""Offline test of report.apply_patch (item 20; stdlib only, synthetic temp directories, no Jev call, never reads .handoff-verify/): explicit per-file approval, expected hash, an exclusive non-overwriting backup
<file>.bak-<UTC>[-N] holding the verified bytes, and an atomic replace of the CANONICAL target through a uniquely created temporary file written as explicit UTF-8 bytes.
The target identity (canonical resolution and inode) and the hash are checked again immediately before the replace: a retargeted alias to equal bytes is refused. Every failure leaves the original bytes and removes only
the operation's own temporary file; an external update is never restored over. usage: python3 -B test_apply_patch.py [-v]"""
import hashlib, os, re, stat, subprocess, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import report

ORIG, NEW = "alpha\nbeta\n", "alpha\ngamma — ăîșțâ €\n"
NOW = report.datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=report.datetime.timezone.utc)
def sha(t): return hashlib.sha256(t.encode("utf-8")).hexdigest()
def read(p): return open(p, "rb").read()

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.d = os.path.realpath(self.tmp.name)
        self.f = os.path.join(self.d, "HANDOFF.md"); open(self.f, "w", encoding="utf-8").write(ORIG)
    def names(self): return sorted(os.listdir(self.d))
    def only_original(self): self.assertEqual(self.names(), ["HANDOFF.md"]); self.assertEqual(read(self.f), ORIG.encode())

class Refusals(Base):
    def test_a_missing_or_non_true_approval_changes_nothing_and_makes_no_backup(self):
        for approved in (False, None, "yes", 1, 0):
            with self.assertRaises(PermissionError, msg=repr(approved)): report.apply_patch(self.f, sha(ORIG), NEW, approved, NOW)
        self.only_original()

    def test_an_initial_hash_mismatch_changes_nothing_and_makes_no_backup(self):
        with self.assertRaises(RuntimeError) as cm: report.apply_patch(self.f, sha("something else"), NEW, True, NOW)
        self.assertIn("hash mismatch", str(cm.exception)); self.only_original()

    def test_a_final_hash_mismatch_keeps_the_external_update_and_removes_only_its_temporary_file(self):
        real_fsync = os.fsync
        def external_update(fd):
            real_fsync(fd); open(self.f, "wb").write(b"updated by someone else\n")   # between the first check and the replace
        with mock.patch("os.fsync", external_update):
            with self.assertRaises(RuntimeError) as cm: report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertIn("hash mismatch", str(cm.exception))
        self.assertEqual(read(self.f), b"updated by someone else\n")   # never restored, never overwritten
        self.assertEqual([n for n in self.names() if n.startswith(".apply-patch-")], [])

    def test_a_target_replaced_by_another_file_with_equal_bytes_is_refused(self):
        real_fsync = os.fsync; other = os.path.join(self.d, "other.tmp")
        def swap(fd):
            real_fsync(fd); open(other, "w", encoding="utf-8").write(ORIG); os.replace(other, self.f)   # same bytes, another inode
        with mock.patch("os.fsync", swap):
            with self.assertRaises(RuntimeError) as cm: report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertIn("no longer the file", str(cm.exception)); self.assertEqual(read(self.f), ORIG.encode())
        self.assertEqual([n for n in self.names() if n.startswith(".apply-patch-")], [])

class Aliases(Base):
    def setUp(self):
        super().setUp(); self.sub = os.path.join(self.d, "sub"); os.makedirs(self.sub)
        self.alias = os.path.join(self.sub, "alias.md"); os.symlink(self.f, self.alias)

    def test_a_symlink_alias_patches_the_canonical_target_and_stays_an_alias(self):
        bak = report.apply_patch(self.alias, sha(ORIG), NEW, True, NOW)
        self.assertTrue(os.path.islink(self.alias)); self.assertEqual(os.path.realpath(self.alias), self.f)
        self.assertEqual(read(self.f), NEW.encode("utf-8")); self.assertFalse(os.path.islink(self.f))
        self.assertEqual(bak, "%s.bak-20260102T030405Z" % self.alias); self.assertEqual(read(bak), ORIG.encode())   # named after the path that was given
        self.assertEqual([n for n in os.listdir(self.d) if n.startswith(".apply-patch-")], [])

    def test_an_alias_retargeted_to_equal_bytes_before_the_replace_is_refused(self):
        twin = os.path.join(self.d, "twin.md"); open(twin, "w", encoding="utf-8").write(ORIG)   # equal bytes, another file
        real_fsync = os.fsync
        def retarget(fd):
            real_fsync(fd); os.unlink(self.alias); os.symlink(twin, self.alias)
        with mock.patch("os.fsync", retarget):
            with self.assertRaises(RuntimeError) as cm: report.apply_patch(self.alias, sha(ORIG), NEW, True, NOW)
        self.assertIn("no longer resolves", str(cm.exception))
        self.assertEqual((read(self.f), read(twin)), (ORIG.encode(), ORIG.encode())); self.assertEqual(os.path.realpath(self.alias), twin)
        self.assertEqual([n for n in os.listdir(self.d) + os.listdir(self.sub) if n.startswith(".apply-patch-")], [])

class Content(Base):
    def test_the_mode_of_the_target_is_preserved(self):
        for mode in (0o640, 0o755, 0o600):
            os.chmod(self.f, mode)
            report.apply_patch(self.f, sha(read(self.f).decode()), NEW + str(mode), True, NOW.replace(second=mode % 50)); self.assertEqual(stat.S_IMODE(os.stat(self.f).st_mode), mode, oct(mode))
            open(self.f, "w", encoding="utf-8").write(ORIG)

    def test_non_ascii_content_is_exact_utf8_whatever_the_locale(self):
        code = ("import sys; sys.path.insert(0, %r); import report, datetime\n"
                "b = report.apply_patch(%r, %r, 'ăîșțâ — € 日本語\\n', True, datetime.datetime(2026,1,2,3,4,5,tzinfo=datetime.timezone.utc)); print(b)\n") % (HERE, self.f, sha(ORIG))
        env = dict(os.environ, LC_ALL="C", PYTHONUTF8="0", PYTHONDONTWRITEBYTECODE="1"); env.pop("LANG", None); env.pop("PYTHONIOENCODING", None)
        p = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, env=env)
        self.assertEqual(p.returncode, 0, p.stderr.decode("utf-8", "replace"))
        self.assertEqual(read(self.f), "ăîșțâ — € 日本語\n".encode("utf-8")); self.assertEqual(read(p.stdout.decode().strip()), ORIG.encode())

class Failures(Base):
    def assert_intact(self):
        self.assertEqual(read(self.f), ORIG.encode()); self.assertEqual([n for n in self.names() if n.startswith(".apply-patch-")], [])

    def test_an_encoding_failure_changes_nothing_and_creates_nothing(self):
        with self.assertRaises(UnicodeEncodeError): report.apply_patch(self.f, sha(ORIG), "bad \ud800 surrogate", True, NOW)
        self.only_original()

    def test_a_partial_write_failure_leaves_the_original_and_no_temporary_file(self):
        real_write = os.write; state = dict(n=0)
        def partial(fd, data):
            state["n"] += 1
            if state["n"] == 1: return real_write(fd, bytes(data[:3]))   # a short write that is completed by the loop
            raise OSError(28, "No space left on device")
        with mock.patch("os.write", partial):
            with self.assertRaises(OSError): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assert_intact_after_backup()

    def assert_intact_after_backup(self):
        self.assertEqual(read(self.f), ORIG.encode()); self.assertEqual([n for n in self.names() if n.startswith(".apply-patch-")], [])
        self.assertEqual([n for n in self.names() if ".bak-" in n], ["HANDOFF.md.bak-20260102T030405Z"])   # the backup made before the failure is kept and holds the original
        self.assertEqual(read(os.path.join(self.d, "HANDOFF.md.bak-20260102T030405Z")), ORIG.encode())

    def test_a_short_write_is_completed(self):
        real_write = os.write
        def short(fd, data): return real_write(fd, bytes(data[:2]))
        with mock.patch("os.write", short): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertEqual(read(self.f), NEW.encode("utf-8"))

    def test_a_close_failure_leaves_the_original_and_no_temporary_file(self):
        real_close = os.close; hit = dict(fd=None)
        real_fsync = os.fsync
        def mark(fd): hit["fd"] = fd; real_fsync(fd)
        def failing_close(fd):
            real_close(fd)
            if fd == hit["fd"]: raise OSError(5, "Input/output error")
        with mock.patch("os.fsync", mark), mock.patch("os.close", failing_close):
            with self.assertRaises(OSError): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assert_intact_after_backup()

    def test_an_fsync_failure_leaves_the_original_and_no_temporary_file(self):
        with mock.patch("os.fsync", side_effect=OSError(5, "Input/output error")):
            with self.assertRaises(OSError): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assert_intact_after_backup()

    def test_a_replace_failure_leaves_the_original_and_no_temporary_file(self):
        with mock.patch("os.replace", side_effect=OSError(18, "Invalid cross-device link")):
            with self.assertRaises(OSError): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assert_intact_after_backup()

class Backups(Base):
    def test_the_backup_holds_the_verified_bytes_keeps_the_metadata_and_is_named_by_the_utc_stamp(self):
        os.chmod(self.f, 0o640); os.utime(self.f, (1_700_000_000, 1_700_000_000))
        bak = report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertEqual(bak, self.f + ".bak-20260102T030405Z"); self.assertEqual(read(bak), ORIG.encode())
        self.assertEqual(stat.S_IMODE(os.stat(bak).st_mode), 0o640); self.assertEqual(int(os.stat(bak).st_mtime), 1_700_000_000)   # copy2-equivalent metadata
        self.assertTrue(re.search(r"\.bak-\d{8}T\d{6}Z$", bak))

    def test_a_name_collision_never_overwrites_an_existing_backup(self):
        first = self.f + ".bak-20260102T030405Z"; open(first, "w").write("SENTINEL")
        b1 = report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertEqual(b1, first + "-1"); self.assertEqual(read(first), b"SENTINEL"); self.assertEqual(read(b1), ORIG.encode())
        b2 = report.apply_patch(self.f, sha(NEW), NEW + "more\n", True, NOW)
        self.assertEqual(b2, first + "-2"); self.assertEqual(read(b1), ORIG.encode()); self.assertEqual(read(b2), NEW.encode("utf-8")); self.assertEqual(read(self.f), (NEW + "more\n").encode("utf-8"))

    def test_the_backup_is_created_exclusively(self):
        flags = []; real_open = os.open
        def spy(path, fl, *a, **k):
            if ".bak-" in str(path): flags.append(fl)
            return real_open(path, fl, *a, **k)
        with mock.patch("os.open", spy): report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertTrue(flags and all(f & os.O_EXCL and f & os.O_CREAT for f in flags))

    def test_identity_world_depends_on_the_return_value_and_the_backup_bytes(self):
        bak = report.apply_patch(self.f, sha(ORIG), NEW, True, NOW)
        self.assertTrue(os.path.isfile(bak) and bak.startswith(self.f + ".bak-")); self.assertEqual(read(bak), ORIG.encode())

if __name__ == "__main__": unittest.main()
