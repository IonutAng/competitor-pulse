# The provided mock LLM server, unmodified. Zero dependencies, so a slim base image is enough.
FROM python:3.13-slim

WORKDIR /srv
COPY mock-llm-server.py .

ENV PORT=4001 \
    PYTHONUNBUFFERED=1
EXPOSE 4001

# No curl in the slim image; use the stdlib against the server's own /health endpoint.
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD python3 -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=2)"

CMD ["python3", "mock-llm-server.py"]
