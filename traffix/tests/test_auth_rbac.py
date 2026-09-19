import unittest
import sys
from pathlib import Path
from fastapi.testclient import TestClient

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

from traffix.api.app import app
from traffix.auth.database import init_db, SessionLocal
from traffix.auth.models import User, AuditLog, RefreshToken
from traffix.auth.seed import seed_database

class TestAuthAndRBAC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Initialize database and seed users
        init_db()
        seed_database()
        cls.client = TestClient(app)

    def _get_token_for_user(self, username: str, password: str) -> str:
        res = self.client.post("/auth/login", json={"username_or_email": username, "password": password})
        self.assertEqual(res.status_code, 200, f"Failed to login {username}: {res.text}")
        return res.json()["access_token"]

    def test_01_login_success_and_jwt_generation(self):
        """Test successful authentication with valid credentials returns JWT tokens."""
        res = self.client.post("/auth/login", json={
            "username_or_email": "admin",
            "password": "AdminPass123!"
        })
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("access_token", data)
        self.assertIn("refresh_token", data)
        self.assertEqual(data["user"]["role"], "admin")
        self.assertEqual(data["user"]["username"], "admin")

        # Verify /auth/me returns the user profile
        headers = {"Authorization": f"Bearer {data['access_token']}"}
        me_res = self.client.get("/auth/me", headers=headers)
        self.assertEqual(me_res.status_code, 200)
        self.assertEqual(me_res.json()["email"], "admin@traffix.gov.in")

    def test_02_login_failure_invalid_password(self):
        """Test invalid credentials return 401 Unauthorized."""
        res = self.client.post("/auth/login", json={
            "username_or_email": "operator",
            "password": "WrongPassword999!"
        })
        self.assertEqual(res.status_code, 401)
        self.assertIn("Invalid username or password", res.json()["detail"])

    def test_03_account_lockout_after_5_failures(self):
        """Test account is locked for 10 minutes after 5 failed login attempts."""
        # Get or create a temporary user for lockout test
        db = SessionLocal()
        try:
            from traffix.auth.security import get_password_hash
            temp_user = db.query(User).filter(User.username == "lockout_tester").first()
            if not temp_user:
                temp_user = User(
                    username="lockout_tester",
                    email="lockout@traffix.gov.in",
                    full_name="Lockout Test User",
                    hashed_password=get_password_hash("ValidPass123!"),
                    role="viewer",
                    is_active=True
                )
                db.add(temp_user)
            else:
                temp_user.failed_login_attempts = 0
                temp_user.locked_until = None
                temp_user.is_active = True
                temp_user.hashed_password = get_password_hash("ValidPass123!")
            db.commit()
        finally:
            db.close()

        # Attempt 5 incorrect logins
        for i in range(5):
            res = self.client.post("/auth/login", json={
                "username_or_email": "lockout_tester",
                "password": "WrongPassword!"
            })
            self.assertEqual(res.status_code, 401)

        # 6th attempt must be locked out (429 Too Many Requests)
        res_locked = self.client.post("/auth/login", json={
            "username_or_email": "lockout_tester",
            "password": "ValidPass123!"
        })
        self.assertEqual(res_locked.status_code, 429)
        self.assertIn("locked", res_locked.json()["detail"].lower())

    def test_04_token_refresh(self):
        """Test refreshing access token using refresh token."""
        login_res = self.client.post("/auth/login", json={
            "username_or_email": "planner",
            "password": "PlannerPass123!"
        })
        refresh_tok = login_res.json()["refresh_token"]

        ref_res = self.client.post("/auth/refresh", json={"refresh_token": refresh_tok})
        self.assertEqual(ref_res.status_code, 200)
        self.assertIn("access_token", ref_res.json())

    def test_05_rbac_matrix_permissions(self):
        """
        Verify RBAC enforcement across all roles on protected endpoints:
        - /api/alerts: operator, field_officer, admin -> 200; planner, viewer -> 403
        - /api/forecast: operator, admin -> 200; field_officer, planner, viewer -> 403
        - /api/infrastructure: planner, admin -> 200; operator, field_officer, viewer -> 403
        - /users: admin -> 200; operator, field_officer, planner, viewer -> 403
        """
        tokens = {
            "admin": self._get_token_for_user("admin", "AdminPass123!"),
            "operator": self._get_token_for_user("operator", "OperatorPass123!"),
            "officer": self._get_token_for_user("officer", "OfficerPass123!"),
            "planner": self._get_token_for_user("planner", "PlannerPass123!"),
            "viewer": self._get_token_for_user("viewer", "ViewerPass123!")
        }

        # 1. /api/alerts (Allowed: operator, field_officer, admin)
        for role, tok in tokens.items():
            r = self.client.get("/api/alerts", headers={"Authorization": f"Bearer {tok}"})
            expected = 200 if role in ["operator", "officer", "admin"] else 403
            self.assertEqual(r.status_code, expected, f"Role {role} failed on /api/alerts: got {r.status_code}")

        # 2. /api/forecast (Allowed: operator, admin)
        for role, tok in tokens.items():
            r = self.client.get("/api/forecast?segment_id=R0001", headers={"Authorization": f"Bearer {tok}"})
            expected = 200 if role in ["operator", "admin"] else 403
            self.assertEqual(r.status_code, expected, f"Role {role} failed on /api/forecast: got {r.status_code}")

        # 3. /api/infrastructure (Allowed: planner, admin)
        for role, tok in tokens.items():
            r = self.client.get("/api/infrastructure", headers={"Authorization": f"Bearer {tok}"})
            expected = 200 if role in ["planner", "admin"] else 403
            self.assertEqual(r.status_code, expected, f"Role {role} failed on /api/infrastructure: got {r.status_code}")

        # 4. /users (Admin only)
        for role, tok in tokens.items():
            r = self.client.get("/users", headers={"Authorization": f"Bearer {tok}"})
            expected = 200 if role == "admin" else 403
            self.assertEqual(r.status_code, expected, f"Role {role} failed on /users: got {r.status_code}")

        # 5. /api/field/incident-action (Field officer, admin)
        for role, tok in tokens.items():
            r = self.client.post(
                "/api/field/incident-action",
                json={"incident_id": "INC_TEST_01", "status": "reached", "notes": "On scene"},
                headers={"Authorization": f"Bearer {tok}"}
            )
            expected = 200 if role in ["officer", "admin"] else 403
            self.assertEqual(r.status_code, expected, f"Role {role} failed on /api/field/incident-action: got {r.status_code}")

    def test_06_admin_user_management_crud(self):
        """Test admin can create, update, list, and delete users."""
        admin_token = self._get_token_for_user("admin", "AdminPass123!")
        headers = {"Authorization": f"Bearer {admin_token}"}

        # 1. Create User
        create_res = self.client.post("/users", json={
            "username": "new_operator",
            "email": "new_op@traffix.gov.in",
            "full_name": "New Trainee Operator",
            "password": "SecurePass123!",
            "role": "operator"
        }, headers=headers)
        self.assertEqual(create_res.status_code, 201)
        new_id = create_res.json()["id"]

        # 2. Update User (change role to planner)
        patch_res = self.client.patch(f"/users/{new_id}", json={
            "role": "planner"
        }, headers=headers)
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.json()["role"], "planner")

        # 3. Delete User
        del_res = self.client.delete(f"/users/{new_id}", headers=headers)
        self.assertEqual(del_res.status_code, 200)

        # 4. Verify Admin cannot delete themselves
        me_res = self.client.get("/auth/me", headers=headers)
        admin_id = me_res.json()["id"]
        del_self_res = self.client.delete(f"/users/{admin_id}", headers=headers)
        self.assertEqual(del_self_res.status_code, 400)
        self.assertIn("cannot delete your own", del_self_res.json()["detail"].lower())

    def test_07_audit_logging_integrity(self):
        """Test that operational actions generate traceable audit logs."""
        op_token = self._get_token_for_user("operator", "OperatorPass123!")
        headers_op = {"Authorization": f"Bearer {op_token}"}

        # Acknowledge an alert
        ack_res = self.client.post(
            "/api/alerts/INC_TEST_ALERT_101/action",
            json={"action": "acknowledge", "notes": "CCTV dispatched"},
            headers=headers_op
        )
        self.assertEqual(ack_res.status_code, 200)

        # Approve an advisory
        adv_res = self.client.post(
            "/api/advisories/ADV_TEST_001/action",
            json={"action": "approve", "reason": "Congestion relief needed"},
            headers=headers_op
        )
        self.assertEqual(adv_res.status_code, 200)

        # Verify audit logs as admin
        admin_token = self._get_token_for_user("admin", "AdminPass123!")
        headers_admin = {"Authorization": f"Bearer {admin_token}"}

        audit_res = self.client.get("/audit-logs", headers=headers_admin)
        self.assertEqual(audit_res.status_code, 200)
        logs = audit_res.json()
        self.assertGreater(len(logs), 0)

        actions_recorded = [l["action"] for l in logs]
        self.assertIn("alert_acknowledge", actions_recorded)
        self.assertIn("advisory_approve", actions_recorded)

    def test_08_civilian_signup_and_emergency_account_admin_restriction(self):
        """Test public registration is strictly for civilians, and emergency accounts require admin."""
        import uuid
        uid = uuid.uuid4().hex[:6]

        # 1. Public civilian registration succeeds (201 Created)
        civ_payload = {
            "full_name": "Priya Sharma",
            "username": f"priya_civ_{uid}",
            "email": f"priya_{uid}@traffix.gov.in",
            "password": "CivilianPass123!"
        }
        res_signup = self.client.post("/auth/register", json=civ_payload)
        self.assertEqual(res_signup.status_code, 201)
        data = res_signup.json()
        self.assertEqual(data["user"]["role"], "viewer", "Public signup MUST enforce civilian/viewer role")
        self.assertIn("access_token", data)
        civ_token = data["access_token"]

        # 2. Public registration with emergency or admin role is BLOCKED (403 Forbidden)
        res_emerg_hack = self.client.post("/auth/register", json={
            "full_name": "Fake EMS Dispatcher",
            "username": f"fake_ems_{uid}",
            "email": f"fake_ems_{uid}@traffix.gov.in",
            "password": "HackPassword123!",
            "role": "emergency"
        })
        self.assertEqual(res_emerg_hack.status_code, 403, "Public sign-up MUST reject emergency role")

        res_admin_hack = self.client.post("/auth/register", json={
            "full_name": "Fake Admin",
            "username": f"fake_admin_{uid}",
            "email": f"fake_admin_{uid}@traffix.gov.in",
            "password": "HackPassword123!",
            "role": "admin"
        })
        self.assertEqual(res_admin_hack.status_code, 403, "Public sign-up MUST reject admin role")

        # 3. Civilian user CANNOT provision emergency account via /users (403 Forbidden)
        civ_headers = {"Authorization": f"Bearer {civ_token}"}
        res_civ_provision = self.client.post("/users", json={
            "full_name": "Unauthorized EMS Unit",
            "username": f"unauth_ems_{uid}",
            "email": f"unauth_ems_{uid}@traffix.gov.in",
            "password": "EmsPassword123!",
            "role": "emergency"
        }, headers=civ_headers)
        self.assertEqual(res_civ_provision.status_code, 403, "Non-admin cannot create users via /users")

        # 4. Authenticated Admin CAN provision emergency account (201 Created)
        admin_token = self._get_token_for_user("admin", "AdminPass123!")
        admin_headers = {"Authorization": f"Bearer {admin_token}"}
        res_admin_provision = self.client.post("/users", json={
            "full_name": "Official 108 EMS Unit 5",
            "username": f"ems_unit5_{uid}",
            "email": f"ems5_{uid}@traffix.gov.in",
            "password": "EmergencyPass123!",
            "role": "emergency"
        }, headers=admin_headers)
        self.assertEqual(res_admin_provision.status_code, 201)
        created_user = res_admin_provision.json()
        self.assertEqual(created_user["role"], "emergency")
        self.assertEqual(created_user["username"], f"ems_unit5_{uid}")

if __name__ == "__main__":
    unittest.main()

