# Terminal 3 T3N SDK — Documentation Gaps & Bugs Report

> Submitted for the **$200 Documentation Gaps bounty** — Terminal 3 Agent Dev Kit Bounty Challenge (beta)  
> Reporter: Gideon145  
> Date: June 5, 2026

---

## Summary

This report documents **10 issues** discovered during integration of `@terminal3/t3n-sdk` (v3.4.4) into the VEIL Protocol autonomous CDS settlement agent. Issues range from broken documentation links to type mismatches and missing onboarding flows.

| # | Severity | Category | Issue |
|---|---|---|---|
| 1 | 🔴 Critical | Onboarding | SDK package name mismatch — hackathon page ≠ npm |
| 2 | 🔴 Critical | Onboarding | GitHub org `terminal3` has zero public repositories |
| 3 | 🔴 Critical | Docs | 6 documentation pages return HTTP 404 |
| 4 | 🟠 High | Docs | No installation/quickstart page on docs site |
| 5 | 🟠 High | SDK | `authenticate()` returns `Did` object, not `string` — undocumented type |
| 6 | 🟡 Medium | SDK | `getUsage()` return type not documented |
| 7 | 🟡 Medium | Docs | No end-to-end quickstart combining wallet + handshake + auth |
| 8 | 🟡 Medium | Onboarding | Test token claim page disconnected from developer docs |
| 9 | 🟡 Medium | SDK | `setEnvironment()` ordering requirement hidden |
| 10 | 🟢 Low | Docs | No WASM troubleshooting or error messages guide |

---

## Detailed Findings

### 1. SDK Package Name Mismatch 🔴

**Location:** Hackathon page vs npm registry

**Issue:** The DoraHacks hackathon page (t3adkdevchallengebeta) refers to an "Agent Auth SDK" throughout, including the claim page code snippet that imports from `@terminal3/t3n-sdk`. However, there is no package named `@terminal3/agent-auth-sdk` on npm. The actual package is `@terminal3/t3n-sdk`.

**Impact:** New developers searching for "terminal3 agent auth sdk" on npm find nothing and assume the SDK isn't public yet. At least one hackathon registrant (this reporter) assumed SDK access required emailing `devrel@terminal3.io`.

**Fix:** Either publish `@terminal3/agent-auth-sdk` as an alias, or update all hackathon copy to reference `@terminal3/t3n-sdk` consistently. Also add a note on the claim page: "The npm package is `@terminal3/t3n-sdk`."

```diff
- import { ... } from "@terminal3/t3n-sdk";  // Inconsistent naming
+ import { ... } from "@terminal3/agent-auth-sdk";  // Or rename npm package
+ // At minimum: document that @terminal3/t3n-sdk IS the Agent Auth SDK
```

---

### 2. Empty GitHub Organization 🔴

**Location:** https://github.com/terminal3

**Issue:** The GitHub organization `terminal3` (capitalized) has **zero public repositories**. The lowercase `terminal3` also has zero repos. The SDK's `package.json` points to `https://github.com/Terminal-3/trinity` as the repository, but this org (`Terminal-3`) also has no public repos.

**Impact:** Developers cannot:
- Browse source code
- File issues or feature requests
- See examples or starter templates
- Verify the SDK is actively maintained (no commits visible)

This is a major trust issue for developers evaluating whether to build on T3N. The hackathon encourages "public GitHub repo" submissions but Terminal 3's own code is hidden.

**Fix:** Make the `trinity` repository public (at minimum the `client/t3n-sdk` directory). Add a README with badges, install instructions, and a link to docs.

---

### 3. Broken Documentation Pages (6× 404) 🔴

**Location:** https://docs.terminal3.io

**Issue:** The following URLs return HTTP 404, despite being linked or expected navigation paths from the docs homepage:

| URL | Expected Content |
|---|---|
| `/developers/overview` | Developer overview / SDK intro |
| `/developers/quickstart` | Quickstart guide |
| `/developers/getting-started` | Getting started |
| `/developers/installation` | npm install instructions |
| `/developers/sdk` | SDK reference |
| `/developers/agent-auth` | Agent Auth SDK specific docs |

**Additional:** The docs homepage links to "Getting started" but the link target doesn't resolve to a valid page.

**Impact:** Developers who land on `docs.terminal3.io` see marketing content about what T3N is, but have no clickable path to actually install and use the SDK. The only working documentation is the README inside the npm package itself, which is invisible until you `npm install`.

**Fix:** Create at minimum `/developers/quickstart` with:
1. `npm install @terminal3/t3n-sdk`
2. Claim API key link
3. 10-line code snippet (handshake → authenticate → getUsage)
4. Link to full API reference

---

### 4. No Installation/Quickstart on Docs Site 🟠

**Location:** https://docs.terminal3.io

**Issue:** The docs homepage has architecture overviews (What is T3N, How T3N Works, TEE Contracts, Host API) but **no page that tells a developer how to install the SDK**. The only place with `npm install` instructions is the SDK's own README (inside `node_modules`).

**Impact:** High bounce rate. A developer who visits docs.terminal3.io and clicks through the sidebar will never find the install command. They must either:
1. Find the claim page (separate domain: terminal3.io/claim-page)
2. Guess the npm package name
3. Install it blind and read the README from `node_modules`

**Fix:** Add a prominent "Developers" section in the docs sidebar with a Quickstart page as the first item.

---

### 5. `authenticate()` Returns `Did` Object, Not `string` 🟠

**Location:** `@terminal3/t3n-sdk` v3.4.4 — `T3nClient.authenticate()`

**Issue:** The SDK README and all code examples show:

```typescript
const did = await client.authenticate(createEthAuthInput(address));
console.log(did); // Expected: "did:t3n:eth:0x..."
```

However, `authenticate()` returns a `Did` interface:

```typescript
interface Did {
  readonly authenticated: boolean;
  readonly did?: Did;  // Recursive!
}
```

The actual DID string is nested inside `didObj.did`, not returned directly. This causes:

```
Type 'Did' is not assignable to type 'string'.  (TS2322)
```

**Workaround used:**

```typescript
const didObj: any = await client.authenticate(createEthAuthInput(address));
const agentDid = didObj?.did ?? String(didObj);
```

**Impact:** Every TypeScript developer hits this. The README example is wrong. The type is recursive (`did?: Did`) which seems like a bug — a DID shouldn't contain another DID of the same type.

**Fix:** Either:
1. Change `authenticate()` return type to `string` and unwrap internally
2. Document the `Did` interface structure in the README and show `result.did` access pattern
3. Investigate the recursive `did?: Did` — this is likely a typo for `did?: string`

---

### 6. `getUsage()` Return Type Not Documented 🟡

**Location:** `T3nClient.getUsage()`

**Issue:** The only documentation for `getUsage()` is this snippet from the claim page:

```typescript
const { balance } = await client.getUsage();
console.log(`Credits available: ${balance.available}`);
```

But:
- What are the other fields on `balance`? (`total`? `used`? `locked`?)
- What is the return type? Is there a top-level object besides `balance`?
- What units are the credits? Are they the same as the 20,000 test tokens?

**Fix:** Add `getUsage()` to the SDK README with the full return type documented.

---

### 7. No End-to-End Quickstart Flowing Wallet → Handshake → Auth 🟡

**Location:** SDK README + docs.terminal3.io

**Issue:** The SDK README has three separate sections (Basic Usage, Ethereum Authentication, OIDC Authentication) but no single flow that takes a developer from "I just claimed my API key" to "I have an authenticated session with a DID."

Missing steps:
1. Where to put the API key (`.env`? Direct parameter?)
2. What the API key represents (it's a private key — document this)
3. How `eth_get_address(key)` derives an address from a private key
4. Whether `setEnvironment("testnet")` must be called before or after `loadWasmComponent()`

**Fix:** Add a "5-Minute Quickstart" section at the top of the README:

```typescript
// 1. Set environment
setEnvironment("testnet");

// 2. Load WASM (must be async)
const wasm = await loadWasmComponent();

// 3. Derive address from your API key (it's a private key)
const address = eth_get_address(process.env.T3N_API_KEY!);

// 4. Create client
const client = new T3nClient({
  wasmComponent: wasm,
  handlers: { EthSign: metamask_sign(address, undefined, process.env.T3N_API_KEY!) },
});

// 5. Handshake
await client.handshake();

// 6. Authenticate
const result = await client.authenticate(createEthAuthInput(address));
console.log("Agent DID:", result.did ?? result);

// 7. Check balance
const { balance } = await client.getUsage();
console.log("Credits:", balance.available);
```

---

### 8. Test Token Claim Page Disconnected from Docs 🟡

**Location:** https://www.terminal3.io/claim-page

**Issue:** The claim page has an excellent interactive code demo, but:
- It's on a separate domain from docs.terminal3.io
- It's not linked from the docs homepage
- The "Claim tokens" button flow is unclear — does the API key get issued immediately? Is it the private key shown?
- No mention that the claim page IS the developer onboarding

**Impact:** A developer who starts at docs.terminal3.io never finds the claim page. A developer who starts at the hackathon page finds the claim page but never finds the docs.

**Fix:** Cross-link prominently:
- Docs homepage: "🚀 New? Claim test tokens →"
- Claim page: "📚 Full SDK docs →"

---

### 9. `setEnvironment()` Ordering Requirement Hidden 🟡

**Location:** `@terminal3/t3n-sdk`

**Issue:** `setEnvironment("testnet")` sets the default T3N node URL for clients created afterward. But:
- The README doesn't specify whether you can call it after `new T3nClient(...)`
- If `baseUrl` is provided to the constructor, it takes precedence over `setEnvironment()` — this interaction is undocumented
- The claim page snippet calls `setEnvironment` at the top but doesn't explain why

**Impact:** Developers who set environment after creating the client may connect to the wrong network without realizing it.

**Fix:** Document the precedence:
```typescript
// Options for targeting a network, in order of precedence:
// 1. Explicit baseUrl in T3nClient constructor (overrides everything)
// 2. setEnvironment("testnet" | "production") — sets default for subsequent clients
// 3. If neither is set — behavior is undefined (document what happens)
```

---

### 10. No WASM Troubleshooting Guide 🟢

**Location:** SDK README / docs

**Issue:** The SDK relies on a WASM component (`session.core.wasm`) for all cryptographic operations. If WASM loading fails, the error is opaque:

```
Error: Failed to load WASM component
```

No guidance on:
- What Node.js versions are compatible
- Whether bundlers (Webpack, Vite, esbuild) need special WASM configuration
- Whether the WASM file needs to be served with specific Content-Type headers
- Common failure reasons (missing file, version mismatch, platform incompatibility)

**Fix:** Add a Troubleshooting section to the README covering WASM, Node.js version requirements, and bundler config.

---

## Bonus: Inconsistent SDK Package Name References

| Source | Names Used |
|---|---|
| DoraHacks hackathon page | "Agent Auth SDK", "Agent Developer Kit" |
| Claim page (`terminal3.io/claim-page`) | `@terminal3/t3n-sdk` (in code snippet) |
| docs.terminal3.io | "T3 Agent Developer Kit (ADK)", "T3n TypeScript SDK" |
| npm package | `@terminal3/t3n-sdk` |
| npm package description | "T3n TypeScript SDK" |

**5 different names for the same SDK.** This makes it extremely hard for developers to search for help (Stack Overflow, Google, npm). Standardize on one name, ideally `@terminal3/t3n-sdk` since that's what's published on npm.

---

## Verification

All findings above are reproducible as of June 5, 2026:

```bash
# Verify broken docs pages
curl -o /dev/null -s -w "%{http_code}" https://docs.terminal3.io/developers/quickstart  # 404
curl -o /dev/null -s -w "%{http_code}" https://docs.terminal3.io/developers/overview    # 404

# Verify empty GitHub
curl -s https://api.github.com/orgs/terminal3/repos | jq '. | length'  # 0

# Verify type mismatch
npm install @terminal3/t3n-sdk@3.4.4
grep -A 5 "authenticate(" node_modules/@terminal3/t3n-sdk/dist/index.d.ts
# Returns Promise<Did>, not Promise<string>
```
