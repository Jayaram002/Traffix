import sys
from pathlib import Path
from datetime import datetime

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

from traffix.auth.database import SessionLocal, init_db
from traffix.auth.models import User, UserRole
from traffix.auth.security import get_password_hash

DEMO_USERS = [
    {
        "username": "admin",
        "email": "admin@traffix.gov.in",
        "full_name": "Dr. S. K. Murthy (Director)",
        "password": "AdminPass123!",
        "role": UserRole.ADMIN.value,
        "zone_id": None
    },
    {
        "username": "operator",
        "email": "operator@traffix.gov.in",
        "full_name": "K. Ramesh (Operations Control)",
        "password": "OperatorPass123!",
        "role": UserRole.OPERATOR.value,
        "zone_id": None
    },
    {
        "username": "officer",
        "email": "officer@traffix.gov.in",
        "full_name": "Inspector V. Reddy (EMS & Police)",
        "password": "OfficerPass123!",
        "role": UserRole.FIELD_OFFICER.value,
        "zone_id": "Zone-West"
    },
    {
        "username": "planner",
        "email": "planner@traffix.gov.in",
        "full_name": "Ananya Roy (Urban Infrastructure Analyst)",
        "password": "PlannerPass123!",
        "role": UserRole.PLANNER.value,
        "zone_id": None
    },
    {
        "username": "viewer",
        "email": "viewer@traffix.gov.in",
        "full_name": "Citizen Observer (Hyderabad Public)",
        "password": "ViewerPass123!",
        "role": UserRole.VIEWER.value,
        "zone_id": None
    },
    {
        "username": "ems108",
        "email": "ems108@traffix.gov.in",
        "full_name": "Capt. V. Reddy (EMS 108 Priority Dispatch)",
        "password": "emergency123",
        "role": UserRole.EMERGENCY.value,
        "zone_id": "All-Emergency"
    }
]

def seed_database():
    print("Initializing database tables...")
    init_db()

    db = SessionLocal()
    try:
        created_count = 0
        updated_count = 0

        for u_data in DEMO_USERS:
            existing = db.query(User).filter(
                (User.username == u_data["username"]) | (User.email == u_data["email"])
            ).first()

            if not existing:
                new_u = User(
                    username=u_data["username"],
                    email=u_data["email"],
                    full_name=u_data["full_name"],
                    hashed_password=get_password_hash(u_data["password"]),
                    role=u_data["role"],
                    zone_id=u_data["zone_id"],
                    is_active=True,
                    created_at=datetime.utcnow()
                )
                db.add(new_u)
                created_count += 1
                print(f"[CREATED] {u_data['role'].upper()}: {u_data['username']} ({u_data['email']}) / {u_data['password']}")
            else:
                existing.full_name = u_data["full_name"]
                existing.hashed_password = get_password_hash(u_data["password"])
                existing.role = u_data["role"]
                existing.zone_id = u_data["zone_id"]
                existing.is_active = True
                existing.failed_login_attempts = 0
                existing.locked_until = None
                updated_count += 1
                print(f"[UPDATED] {u_data['role'].upper()}: {u_data['username']} ({u_data['email']}) / {u_data['password']}")

        db.commit()
        print(f"\nDatabase seeding completed successfully! ({created_count} created, {updated_count} updated)")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
