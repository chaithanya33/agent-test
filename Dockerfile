# Demo image for the Secure-ECR pilot.
# Kept minimal so Trivy/Grype have a small surface to scan.

FROM gcr.io/distroless/python3-debian12:nonroot

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health').status==200 else 1)"

CMD ["python", "app.py"]
