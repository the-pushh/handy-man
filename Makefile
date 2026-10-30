# HandyMan — one command does everything.
#
#   make          setup (idempotent) + run backend and frontend together
#   make setup    install backend + frontend dependencies only
#   make up       run backend + frontend together (assumes setup done)
#   make backend  run the FastAPI backend alone (port 8000)
#   make frontend run the Next.js frontend alone (port 3000)
#   make deploy   deploy Glimmer + mms-tts to Modal
#   make auth     authenticate this machine with Modal (opens browser)
#   make clean    remove local build output

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
MODAL := $(PYTHON) -m modal
# Interpreter used to create .venv when it is missing (override if needed).
VENV_PYTHON ?= /opt/homebrew/bin/python3

# 0 = everything runs locally (default; Modal is parked),
# 1 = route Glimmer/TTS through Modal when it becomes functional again.
HANDYMAN_MODAL ?= 0

BACKEND_PORT := 8000
FRONTEND_PORT := 3000

.DEFAULT_GOAL := all
.PHONY: all setup up backend frontend deploy auth clean

all: up

setup:
	@test -x $(PYTHON) || $(VENV_PYTHON) -m venv $(VENV)
	$(PIP) install -q -r backend/requirements.txt
	cd frontend && npm install --no-audit --no-fund

up: setup
	@trap 'kill 0' INT TERM EXIT; \
	HANDYMAN_MODAL=$(HANDYMAN_MODAL) $(PYTHON) -m uvicorn backend.server:app \
		--host 127.0.0.1 --port $(BACKEND_PORT) & \
	cd frontend && npm run dev -- --port $(FRONTEND_PORT) & \
	wait

backend: setup
	HANDYMAN_MODAL=$(HANDYMAN_MODAL) $(PYTHON) -m uvicorn backend.server:app \
		--host 127.0.0.1 --port $(BACKEND_PORT) --reload

frontend: setup
	cd frontend && npm run dev -- --port $(FRONTEND_PORT)

deploy: setup
	$(MODAL) deploy backend/modal_app.py

auth:
	$(MODAL) setup

clean:
	rm -rf frontend/.next
