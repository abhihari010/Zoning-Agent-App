import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv


APP_DIR = Path(__file__).resolve().parent
API_DIR = APP_DIR.parent
REPO_ROOT = API_DIR.parent.parent

load_dotenv(REPO_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env.local", override=True)
load_dotenv(API_DIR / ".env", override=True)
load_dotenv(API_DIR / ".env.local", override=True)

from app.routers.api import router as api_router

app = FastAPI(title="IBM Zoning API", version="0.1.0")

_cors_origins_env = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
if _cors_origins_env == "*":
    _allow_origins = ["*"]
    _allow_credentials = False
elif _cors_origins_env:
    _allow_origins = [origin.strip() for origin in _cors_origins_env.split(",") if origin.strip()]
    _allow_credentials = True
else:
    _allow_origins = ["http://localhost:5173"]
    _allow_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
