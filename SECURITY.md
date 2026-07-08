# Security Policy

## Supported versions

The latest published minor release receives security fixes. Older versions
should upgrade — `npm install -g forkmind@latest`.

## Security model

ForkMind is local-first. Its security posture, in one place:

- **No plaintext context at rest.** Capsules are AES-256-GCM encrypted with a
  per-capsule key, wrapped by a project master key stored *outside* the data
  directory (`~/.forkmind-keys/`, created `0600`).
- **Crypto-shredding deletion.** Forgetting a capsule destroys its key first,
  then tombstones the id, then removes ciphertext everywhere including
  replicas — backups of ciphertext stay unreadable.
- **Immutable, acyclic storage by construction.** Segment ids are hashes over
  content + parents (Git-style); every restore re-verifies parents,
  acyclicity, and content hashes before returning data.
- **Strict input validation.** Capsule/segment ids are validated as 12
  lowercase hex chars before any filesystem path is constructed.
- **Loopback-only by default.** The proxy binds `127.0.0.1`; exposing it on a
  network is an explicit opt-in (`FORKMIND_HOST`) and should sit behind your
  own authentication layer.
- **No telemetry, no cloud, no account.** The only network traffic is the LLM
  call you were already making, relayed verbatim to the provider you chose.
- **Passphrase-hardened export.** Portable bundles use scrypt (N=32768) key
  derivation; imports independently re-verify every segment before writing.

Dependency audits run in CI on every push (`npm audit`, currently 0 known
vulnerabilities in production dependencies).

## Reporting a vulnerability

Please report suspected vulnerabilities privately:

- Open a [GitHub private security advisory](https://github.com/Medhovarsh/forkmind/security/advisories/new) (preferred), or
- Email the maintainer via the address on the [GitHub profile](https://github.com/Medhovarsh).

Please include reproduction steps and impact. You can expect an initial
response within 72 hours. Please do not open public issues for unpatched
vulnerabilities.

## Scope

In scope: the proxy, capsule engine, crypto, replicas, MCP server, CLI, and
dashboard as shipped in this repository. Out of scope: vulnerabilities in
upstream LLM providers or third-party dependencies (report those upstream,
though we appreciate a heads-up to ship a version bump).
