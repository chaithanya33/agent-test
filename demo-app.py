"""Minimal Flask app used as the demo target for the Secure-ECR agent.

This is the CLEAN baseline. On demo day you will apply a "bad" PR that
introduces vulnerabilities, and watch the agent catch them.
"""
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)


@app.route("/health")
def health():
    return jsonify(status="ok")


@app.route("/lookup")
def lookup():
    # Returns the title of a public webpage. Demo of the agent's diff-aware
    # review: the "bad" PR will add unsafe code paths around this.
    url = request.args.get("url", "https://example.com")
    r = requests.get(url, timeout=5)
    return jsonify(status_code=r.status_code, length=len(r.text))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
