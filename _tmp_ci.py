"""临时：拉取本次 CI run 的 job/step 结果（只读公开 API）。"""
import json
import sys
import urllib.request

RUN = "40199944068"
REPO = "SxLiuYu/dotd"


def get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "dotd-ci-check", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


jobs = get(f"https://api.github.com/repos/{REPO}/actions/runs/{RUN}/jobs")
print("jobs total", jobs.get("total_count"))
for j in jobs.get("jobs", []):
    print("JOB", j["name"], j["conclusion"])
    for s in j.get("steps", []):
        tag = s.get("conclusion")
        mark = "  " if tag == "success" else "* "
        print(f"   {mark}{tag:10} {s['name']}")
