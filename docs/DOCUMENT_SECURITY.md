# Document authorization

The completion and production-acceptance status remains in `PRODUCT_TRACEABILITY.md`.

## Resource policy

Document capabilities admit an action; they do not grant every document. Internal source access also requires the trusted document context, every required financial category, and direct subject grants. Connected navigation records are insufficient. Listings enforce this policy in SQL before search, ordering, and limits.

Migration `0046_document_access_context.sql` preserves all existing documents with a null context. Only Owner can access these legacy sources until reviewing and classifying the original, all retained versions, editor state, descriptions, and filenames. The Owner's Document library has a “Classify or share a document” control. The display category never grants access.

New Owner uploads default to Owner-only. Other uploads remain creator-private and capture the creator's effective category permissions. Losing one of those permissions also removes source access. A generated invoice/cover-sheet save validates its invoice on the server and retains its exact individual and category context. Because a client upload cannot prove its bytes came from that URL, this context does not share the upload with coworkers. Owner source classification is required to widen its audience. Class Billing can edit its own saves and classified class documents for directly permitted individuals.

Read-only internal viewers receive current output only. All source streams, original and older versions, draft/editor JSON, saves, restores, and archive actions require source edit access. Version IDs are always resolved within their document. Unsupported `source` parameters fail closed.

## External publication

External identities receive no internal source access. Owner can approve a separately reconstructed immutable artifact for one recipient, one individual/employee, an optional exact agency and source date, and every data category represented by its visible pixels. The recipient also needs an explicit `documents.self.read` grant on the existing portal connection. The portal connection editor provides “Approved documents: Show/Hide”; no preset grants this capability by default.

The client-supplied `secure` export label is insufficient. Before approval, the server validates the canonical raster exporter structure and constructs a new PDF from bounded decoded RGB page pixels. Source objects, compressed streams, metadata, attachment names/content, editor state, and hidden text are never copied. Unsupported page content, masks, or noncanonical rendering features are rejected with instructions to save a fresh Sanitized flattened PDF. The output is written to a unique private `documents/<id>/publications/<random>.pdf` path with overwrite disabled. The database records its size, SHA-256, sanitizer version, recipient scope, approving Owner, and fixed source version.

External listings and detail responses use the approved title, generic filename, artifact size, and approval date. Downloads use only the attested publication path. They never fall back to the source version's output blob. Portal capabilities, denials, direct relationships, and exact dated agency responsibility are rechecked on every request. Archive, explicit revocation, relationship removal, category denial, or loss of current agency responsibility makes the publication inaccessible.

## Repeatable verification

`tests/integration/document-security.test.ts` exercises actual handlers and PostgreSQL policy with all 13 presets, unrelated people and employees, two agencies, denied categories, current/historical memberships, forged source IDs, source-context creation, legacy classification, nested version substitutions, unchanged denied mutations, and explicit publication/revocation. Private storage is replaced by an isolated byte store; authentication enters through a test session adapter. These are integration tests, not a claim of production direct-login acceptance.

Real PDF byte fixtures test retained private metadata/attachments, approved raster reconstruction, and forged `secure` PDFs that still contain text. `tests/pdf-publication-sanitizer.test.ts` covers the sanitizer's structural adversaries. Existing document persistence and storage tests retain save/reopen/restore/upload-boundary coverage. Root release verification supplies browser, direct-login, object-storage, and deployed-commit evidence.
