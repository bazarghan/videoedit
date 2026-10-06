import os
import tempfile

os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="videoedit-tests-")
os.environ["COOKIE_SECURE"] = "false"
os.environ["ADMIN_PASSWORD"] = "test-password-do-not-use"
