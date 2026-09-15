"""No cookies, identity tokens, browser sessions, model calls or resource writes."""
import json
import urllib.error
import urllib.request

PUBLIC = "https://fleet-governance-449245570324.us-central1.run.app"
OPERATOR = "https://fleet-governance-control-449245570324.us-central1.run.app"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

client = urllib.request.build_opener(NoRedirect)
def check(base, path, expected, method="GET", headers=None):
    request = urllib.request.Request(base + path, method=method, headers=headers or {})
    try:
        response = client.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    body = response.read()
    assert response.status in expected, f"{method} {path}: HTTP {response.status}"
    if base == PUBLIC and method == "GET":
        assert not response.headers.get("Location"), f"Unexpected login redirect: {path}"
    print(f"{method} {base}{path}: {response.status}")
    return body

for page in ["/experiments", "/compute", "/constitution", "/info", "/proposals", "/proposals/17758453720459259775115348801772992791284533307697182874480707147019297120429"]:
    check(PUBLIC, page, [200])
for path in ["/api/compute-policy", "/api/experiments", "/api/experiment-defaults"]:
    body = check(PUBLIC, path, [200])
    json.loads(body)
    assert b'"requestedBy"' not in body
votes = json.loads(check(PUBLIC, "/api/archive/votes/17758453720459259775115348801772992791284533307697182874480707147019297120429", [200]))["data"]
assert len(votes) == 5 and all(vote.get("reason") for vote in votes), "The five indexed vote reasons must be publicly readable"
for path in ["/api/simulations", "/api/experiments", "/api/worker/start", "/proposals"]:
    # All requests must fail before their bodies or idempotency keys are considered.
    check(PUBLIC, path, [403], "POST", {"Origin": PUBLIC, "x-goog-authenticated-user-email": "accounts.google.com:operator2@example.com"})
check(OPERATOR, "/experiments", [302, 303, 401, 403])
