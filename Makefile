# HandyMan — one command does everything.
#
#   make          setup (idempotent) + run backend and frontend together
#   make setup    install backend + frontend dependencies only
#   make up       run backend + frontend together (assumes setup done)
#   make phone    tunnel both servers via cloudflared; print the phone URL
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
.PHONY: all setup up backend frontend deploy auth clean phone

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

# Tunnel the running servers (start them first with `make` in another
# terminal) and print the URLs. Open the FRONTEND url on the phone;
# paste the BACKEND url into the app once when it asks for it.
phone:
	@command -v cloudflared >/dev/null || (echo "install cloudflared first: brew install cloudflared"; exit 1)
	@rm -f /tmp/handyman-front.tunnel /tmp/handyman-back.tunnel
	@cloudflared tunnel --url http://127.0.0.1:$(FRONTEND_PORT) > /tmp/handyman-front.tunnel 2>&1 & \
	cloudflared tunnel --url http://127.0.0.1:$(BACKEND_PORT) > /tmp/handyman-back.tunnel 2>&1 & \
	echo "waiting for tunnel urls…"; \
	for i in $$(seq 1 30); do \
		F=$$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/handyman-front.tunnel 2>/dev/null | head -1); \
		B=$$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/handyman-back.tunnel 2>/dev/null | head -1); \
		if [ -n "$$F" ] && [ -n "$$B" ]; then break; fi; \
		sleep 1; \
	done; \
	F=$$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/handyman-front.tunnel 2>/dev/null | head -1); \
	B=$$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/handyman-back.tunnel 2>/dev/null | head -1); \
	echo ""; echo "PHONE (frontend): $$F"; echo "BACKEND (paste in app): $$B"; echo ""; \
	echo "Leave this running; Ctrl-C stops the tunnels."; \
	wait
