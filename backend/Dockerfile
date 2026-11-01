# Handyman backend for Cloud Run. Build from the repo root:
#   docker build -f backend/Dockerfile -t handyman-backend .
# Python matches local dev (3.14). The MMS voices are downloaded at build
# time so a new instance speaks without fetching ~150 MB first.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app

# CPU-only torch (the CUDA build is ~2 GB larger and unused on Cloud Run),
# then everything else pinned in requirements.txt except torch and modal.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.15.0 \
 && grep -vE '^(torch|modal)==' backend/requirements.txt > /tmp/req.txt \
 && pip install -r /tmp/req.txt

# Bake the English and Hindi MMS-TTS voices into the image.
RUN python -c "from transformers import AutoTokenizer, VitsModel; \
[ (AutoTokenizer.from_pretrained(m), VitsModel.from_pretrained(m)) \
  for m in ('facebook/mms-tts-eng', 'facebook/mms-tts-hin') ]"

COPY backend backend

# Run as a non-root user; the model cache stays readable.
RUN useradd --create-home --uid 10001 app && chown -R app /models
USER app

# Cloud Run sets PORT. One worker: TTS and SAM decoding keep their models
# and process pool in memory; concurrency comes from the threadpool.
ENV PORT=8080 HANDYMAN_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn backend.server:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75"]
