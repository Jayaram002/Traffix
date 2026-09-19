from fastapi import APIRouter, Depends, HTTPException, status, Response, Request, Cookie
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta

from traffix.auth.database import get_db
from traffix.auth.models import User, AuditLog, RefreshToken, UserRole
from traffix.auth.security import (
    verify_password, get_password_hash, create_access_token, create_refresh_token,
    decode_token, MAX_FAILED_LOGINS, LOCKOUT_MINUTES
)
from traffix.auth.dependencies import get_current_user, require_role, log_audit

router = APIRouter(tags=["Authentication & RBAC"])

# --- Pydantic Schemas ---
class LoginRequest(BaseModel):
    username_or_email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: Dict[str, Any]

class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None

class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)

class CivilianRegisterRequest(BaseModel):
    email: str = Field(..., min_length=5)
    username: str = Field(..., min_length=3, max_length=50)
    full_name: str = Field(..., min_length=2)
    password: str = Field(..., min_length=6)
    role: Optional[str] = None

class UserCreateRequest(BaseModel):
    email: str = Field(..., min_length=5)
    username: str = Field(..., min_length=3, max_length=50)
    full_name: str
    password: str = Field(..., min_length=6)
    role: str = UserRole.VIEWER.value
    zone_id: Optional[str] = None

class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    zone_id: Optional[str] = None
    unlock_account: Optional[bool] = False

class UserResponse(BaseModel):
    id: int
    email: str
    username: str
    full_name: str
    role: str
    zone_id: Optional[str]
    is_active: bool
    failed_login_attempts: int
    locked_until: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True

# --- Auth Endpoints ---

@router.post("/auth/login", response_model=TokenResponse)
def login(
    req: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    ip = request.client.host if request.client else "unknown"
    identifier = req.username_or_email.strip().lower()

    # Look up by username or email
    user = db.query(User).filter(
        (User.username == identifier) | (User.email == identifier)
    ).first()

    now = datetime.utcnow()

    if not user:
        log_audit(db, action="login_failed", username=identifier, details="Non-existent user attempted login", ip_address=ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    # Check account lockout
    if user.locked_until and user.locked_until > now:
        remaining = int((user.locked_until - now).total_seconds() / 60) + 1
        log_audit(db, action="login_attempt_locked", user=user, details=f"Locked account attempted login. Remaining: {remaining} min", ip_address=ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Account is locked due to too many failed login attempts. Try again in {remaining} minute(s)."
        )

    # Verify password
    if not verify_password(req.password, user.hashed_password):
        user.failed_login_attempts += 1
        details = f"Failed attempt {user.failed_login_attempts} of {MAX_FAILED_LOGINS}"

        if user.failed_login_attempts >= MAX_FAILED_LOGINS:
            user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.failed_login_attempts = 0
            details += f". Account locked for {LOCKOUT_MINUTES} minutes."
            log_audit(db, action="account_locked", user=user, details=details, ip_address=ip)

        db.commit()
        log_audit(db, action="login_failed", user=user, details=details, ip_address=ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    if not user.is_active:
        log_audit(db, action="login_inactive", user=user, details="Inactive user attempted login", ip_address=ip)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account has been deactivated. Please contact an administrator."
        )

    # Successful login: reset failed attempts
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()

    # Generate tokens
    token_data = {"sub": user.username, "role": user.role, "uid": user.id}
    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)

    # Store refresh token record in DB
    ref_entry = RefreshToken(
        user_id=user.id,
        token_hash=get_password_hash(refresh_token[:32]),
        expires_at=datetime.utcnow() + timedelta(days=7)
    )
    db.add(ref_entry)
    db.commit()

    # Set httpOnly cookies
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        max_age=15 * 60,
        samesite="lax",
        secure=False  # Set True in production with HTTPS
    )
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        max_age=7 * 24 * 3600,
        samesite="lax",
        secure=False
    )

    log_audit(db, action="login", user=user, details=f"User signed in successfully with role {user.role}", ip_address=ip)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "full_name": user.full_name,
            "role": user.role,
            "zone_id": user.zone_id
        }
    }

@router.post("/auth/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register_civilian(
    req: CivilianRegisterRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    ip = request.client.host if request.client else "unknown"
    username = req.username.strip().lower()
    email = req.email.strip().lower()

    # RBAC Security Guard: Emergency and operational accounts can ONLY be created by an Admin
    if req.role and req.role.strip().lower() not in [UserRole.VIEWER.value, "civilian", "viewer"]:
        log_audit(db, action="register_forbidden", username=username, details=f"Rejected public signup for restricted role: {req.role}", ip_address=ip)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Public registration is strictly restricted to Civilian Commuter accounts. Emergency (108 EMS) and operational accounts can only be created by an Administrator."
        )

    # Check duplicate username or email
    if db.query(User).filter((User.username == username) | (User.email == email)).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username or email is already registered."
        )

    # Force role to VIEWER (Civilian)
    new_user = User(
        email=email,
        username=username,
        full_name=req.full_name.strip(),
        hashed_password=get_password_hash(req.password),
        role=UserRole.VIEWER.value,
        is_active=True
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    log_audit(db, action="civilian_signup", user=new_user, details=f"Civilian commuter registered: {new_user.username}", ip_address=ip)

    # Auto-login: issue token
    token_data = {"sub": new_user.username, "role": new_user.role, "uid": new_user.id}
    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)

    ref_entry = RefreshToken(
        user_id=new_user.id,
        token_hash=get_password_hash(refresh_token[:32]),
        expires_at=datetime.utcnow() + timedelta(days=7)
    )
    db.add(ref_entry)
    db.commit()

    if response:
        response.set_cookie(
            key="access_token",
            value=access_token,
            httponly=True,
            max_age=15 * 60,
            samesite="lax",
            secure=False
        )
        response.set_cookie(
            key="refresh_token",
            value=refresh_token,
            httponly=True,
            max_age=7 * 24 * 3600,
            samesite="lax",
            secure=False
        )

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "id": new_user.id,
            "username": new_user.username,
            "email": new_user.email,
            "full_name": new_user.full_name,
            "role": new_user.role,
            "zone_id": new_user.zone_id
        }
    }

@router.post("/auth/refresh")
def refresh_token(
    req: RefreshRequest = None,
    request: Request = None,
    response: Response = None,
    refresh_token_cookie: Optional[str] = Cookie(None, alias="refresh_token"),
    db: Session = Depends(get_db)
):
    token = (req.refresh_token if req and req.refresh_token else None) or refresh_token_cookie
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token missing")

    payload = decode_token(token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    username = payload.get("sub")
    user = db.query(User).filter(User.username == username, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Issue fresh access token
    new_access_token = create_access_token({"sub": user.username, "role": user.role, "uid": user.id})

    if response:
        response.set_cookie(
            key="access_token",
            value=new_access_token,
            httponly=True,
            max_age=15 * 60,
            samesite="lax",
            secure=False
        )

    return {
        "access_token": new_access_token,
        "token_type": "bearer"
    }

@router.post("/auth/logout")
def logout(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    # Revoke refresh tokens for this user
    db.query(RefreshToken).filter(RefreshToken.user_id == current_user.id).update({"revoked": True})
    db.commit()

    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")

    log_audit(db, action="logout", user=current_user, details="User logged out")
    return {"message": "Successfully logged out"}

@router.get("/auth/me")
def get_current_user_profile(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": current_user.role,
        "zone_id": current_user.zone_id,
        "is_active": current_user.is_active,
        "created_at": current_user.created_at
    }

@router.post("/auth/change-password")
def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not verify_password(req.old_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password incorrect")

    current_user.hashed_password = get_password_hash(req.new_password)
    # Revoke all refresh tokens to force re-login on other devices
    db.query(RefreshToken).filter(RefreshToken.user_id == current_user.id).update({"revoked": True})
    db.commit()

    log_audit(db, action="password_change", user=current_user, details="Password changed successfully")
    return {"message": "Password changed successfully"}

# --- Admin User Management Endpoints (Requires 'admin' role) ---

@router.get("/users", response_model=List[UserResponse])
def list_users(
    admin_user: User = Depends(require_role("admin")),
    db: Session = Depends(get_db)
):
    return db.query(User).order_by(User.id).all()

@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    req: UserCreateRequest,
    admin_user: User = Depends(require_role("admin")),
    db: Session = Depends(get_db)
):
    # Check duplicate
    if db.query(User).filter((User.username == req.username) | (User.email == req.email)).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username or email already exists")

    # Validate role
    valid_roles = [r.value for r in UserRole]
    if req.role not in valid_roles:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid role. Must be one of: {valid_roles}")

    new_user = User(
        email=req.email,
        username=req.username,
        full_name=req.full_name,
        hashed_password=get_password_hash(req.password),
        role=req.role,
        zone_id=req.zone_id,
        is_active=True
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    log_audit(db, action="user_create", user=admin_user, details=f"Admin created user {new_user.username} with role {new_user.role}")
    return new_user

@router.patch("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    req: UserUpdateRequest,
    admin_user: User = Depends(require_role("admin")),
    db: Session = Depends(get_db)
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    changes = []
    if req.role is not None:
        valid_roles = [r.value for r in UserRole]
        if req.role not in valid_roles:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid role: {req.role}")
        changes.append(f"role: {target.role} -> {req.role}")
        target.role = req.role

    if req.is_active is not None:
        changes.append(f"is_active: {target.is_active} -> {req.is_active}")
        target.is_active = req.is_active

    if req.zone_id is not None:
        target.zone_id = req.zone_id
        changes.append(f"zone: {req.zone_id}")

    if req.unlock_account:
        target.failed_login_attempts = 0
        target.locked_until = None
        changes.append("account unlocked")

    db.commit()
    db.refresh(target)

    log_audit(db, action="user_update", user=admin_user, details=f"Admin updated user {target.username}: {', '.join(changes)}")
    return target

@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    admin_user: User = Depends(require_role("admin")),
    db: Session = Depends(get_db)
):
    if user_id == admin_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own administrative account")

    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    uname = target.username
    db.delete(target)
    db.commit()

    log_audit(db, action="user_delete", user=admin_user, details=f"Admin deleted user {uname} (ID {user_id})")
    return {"message": f"User {uname} successfully deleted"}

# --- Audit Logs Endpoint (Requires 'admin' role) ---

@router.get("/audit-logs")
def get_audit_logs(
    action: Optional[str] = None,
    username: Optional[str] = None,
    limit: int = 100,
    admin_user: User = Depends(require_role("admin")),
    db: Session = Depends(get_db)
):
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    if username:
        query = query.filter(AuditLog.username == username)

    logs = query.order_by(AuditLog.timestamp.desc()).limit(limit).all()
    return [
        {
            "id": l.id,
            "username": l.username,
            "role": l.role,
            "action": l.action,
            "details": l.details,
            "ip_address": l.ip_address,
            "timestamp": l.timestamp.isoformat()
        }
        for l in logs
    ]
