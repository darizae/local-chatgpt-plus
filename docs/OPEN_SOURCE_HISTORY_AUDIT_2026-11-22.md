# Public-source Git history policy

The original development repository and its historical refs remain private. This public candidate was exported from a reviewed source tree into a new Git repository with an independently created **root commit**, not cloned or branched from private history.

Before first publication, verify that the candidate has exactly one reachable root commit, no private remote, no inherited tag/ref or hidden object, and that all tracked files pass offline credential scans and manual privacy review. Historical private Git objects, deletion records and runtime state must not accompany a public repository.

A clean history reduces disclosure from old commits, but **cannot prove the current tree contains no secrets**. Never publish live tunnel IDs, provider tenants, passwords, environment files or machine-specific logs. Rotate any credential known to have appeared in prior public sources at its issuer.
