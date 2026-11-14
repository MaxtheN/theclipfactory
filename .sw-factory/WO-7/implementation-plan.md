# Summary
Add a credential-safe Composio Instagram adapter with explicit connected-account identity. Keep our orchestration; Composio supplies managed authentication and tools.

# Code Reuse And Package Structure
Reuse httpx, SecureTokenStore patterns and existing publication approval rules. New composio.py and tests/test_composio.py own documented REST requests, identity and normalized insights. Root wires API in learning_api.py/autonomy_runtime.py/app.py without overlap.

# Components And Flow
ComposioClient accepts credential plus injectable httpx transport. Initiate auth using auth config and exact user ID; verify account is active, belongs to that user and Instagram toolkit. Every tool execution supplies exact connected account and user. Retrieve live tool schema/version rather than guessing fields. Retrieve insights for exact mapped media; normalize counts, preserve unknowns and never invent paid/organic attribution. Public replies/errors exclude keys/provider exception bodies. Credentials stored via Keychain, not SQLite. OAuth completion is verified server-side before binding. No automatic publication endpoint until exact human approval, clip hash and reconciliation contract are satisfied.

# Steps
1. Research current primary Composio REST and Instagram schemas.
2. Implement adapter and injected HTTP tests only in owned files.
3. Root wires settings/connect/readback/collector with explicit account bindings.
4. Verify malformed/expired/foreign account, bad metric data and timeouts; document account configuration and remaining OAuth grants.

# Testing
Run tests/test_composio.py with mocked httpx transport; assert exact account/user/tool identifiers, no implicit account, credential-safe errors, pagination/bounds and unknown metric handling. No external post or OAuth grant on behalf of user. Live read-only verification requires configured credential and authenticated user identity. Test configurations remain clearly separate from provider evidence.
