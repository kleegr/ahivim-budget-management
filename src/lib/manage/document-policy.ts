import type { DocumentAccess } from "@/lib/auth/document-access";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentAccessContext } from "@/lib/auth/document-policy";
import { canAccessDocumentSource, DOCUMENT_VISIBILITY } from "@/lib/auth/document-policy";
import { isPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";
import { canReadPublication, type DocumentPublication } from "@/lib/auth/document-publications";
import { DOCUMENT_UUID, getDocumentVersionFile } from "@/lib/data/documents";
import { sanitizePdfPublication } from "@/lib/documents/pdf-publication-sanitizer";
import { deletePrivateDocumentBlob, readDocumentBytesForPublication, writePrivateDocumentPublication } from "@/lib/documents/document-storage";
import { recordChange } from "./audit";
import { fail, ok } from "./errors";

/** A source URL is a lookup request, never authority supplied by the browser. */
export async function creationDocumentContext(access: DocumentAccess, source: unknown) {
  if (source === undefined || source === null || source === "") return ok<DocumentAccessContext>(access.scope.role === "admin" ? { kind: "owner" } : {
    kind: "private", requiredCapabilities: DOCUMENT_VISIBILITY.filter((capability) => access.scope[capability]),
  });
  if (typeof source !== "string") return fail("validation", "Choose a valid document source.");
  const match = /^\/api\/classes\/invoices\/([a-f0-9-]{36})\/(pdf|cover-sheet)(?:\?(preview=1|version=[1-9]\d*))?$/i.exec(source);
  if (!match || !DOCUMENT_UUID.test(match[1])) return fail("validation", "That document source is not supported.");
  const requestedVersion = match[3]?.startsWith("version=") ? Number(match[3].slice(8)) : null;
  if (requestedVersion !== null && (match[2] !== "cover-sheet" || !Number.isSafeInteger(requestedVersion) || requestedVersion > 2_147_483_647)) {
    return fail("validation", "Choose a valid cover version.");
  }
  const { rows } = await access.pool.query<{ individual_id: string }>(
    `SELECT individual_id FROM class_invoices WHERE id = $1`, [match[1]],
  );
  const invoice = rows[0];
  const context: DocumentAccessContext = { kind: "classes", individualId: invoice?.individual_id, sourceInvoiceId: match[1] };
  if (!invoice || access.external || !canAccessDocumentSource(access.scope, { accessContext: context, createdByUserId: access.user.id })) {
    return fail("not_found", "That document source was not found.");
  }
  if (match[2] === "cover-sheet") {
    const covers = await access.pool.query<{ version: number }>(`SELECT version FROM (
      SELECT 1 AS version FROM class_cover_sheet_snapshots WHERE class_invoice_id = $1
      UNION ALL SELECT version FROM class_cover_sheet_versions WHERE class_invoice_id = $1
    ) history WHERE ($2::integer IS NULL OR version = $2) ORDER BY version DESC LIMIT 1`, [match[1], requestedVersion]);
    const coverVersion = covers.rows[0]?.version;
    if (requestedVersion !== null && coverVersion === undefined) return fail("not_found", "That finalized cover version was not found.");
    if (coverVersion !== undefined) context.sourceCoverVersion = coverVersion;
  }
  // The client uploads bytes, so a source URL cannot prove that those bytes
  // are the generated invoice. Retain validated scope without widening the
  // audience; only Owner review may classify the complete retained source.
  return ok<DocumentAccessContext>({
    ...context, kind: access.scope.role === "admin" ? "owner" : "private",
    requiredCapabilities: DOCUMENT_VISIBILITY.filter((capability) => access.scope[capability]),
  });
}

export async function updateDocumentAccess(access: DocumentAccess, documentId: string, input: Record<string, unknown>) {
  if (access.user.role !== "admin" || access.scope.role !== "admin") return fail("forbidden", "Owner access required.");
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  const client = await access.pool.connect();
  let uploadedPathname: string | null = null;
  try {
    await client.query("BEGIN");
    const document = await client.query<{ access_context: DocumentAccessContext | null; current_version_id: string | null; status: string }>(
      `SELECT access_context, current_version_id, status FROM documents WHERE id = $1 FOR UPDATE`, [documentId],
    );
    if (!document.rows[0]) { await client.query("ROLLBACK"); return fail("not_found", "That document was not found."); }
    const reject = async (message: string) => { await client.query("ROLLBACK"); return fail("validation", message); };
    if (input.action === "classify") {
      if (input.reviewedEntireSource !== true) return await reject("Review the original, history, and editor contents before classifying the source.");
      const kind = input.kind;
      if (kind !== "owner" && kind !== "classes" && kind !== "planning" && kind !== "payroll" && kind !== "settlements") return await reject("Choose a document audience.");
      const context: DocumentAccessContext = { kind };
      if (kind !== "owner") {
        const individual = typeof input.individualId === "string" && DOCUMENT_UUID.test(input.individualId) ? input.individualId : null;
        const employee = typeof input.employeeId === "string" && DOCUMENT_UUID.test(input.employeeId) ? input.employeeId : null;
        if ((kind === "classes" || kind === "planning") && (!individual || employee)) return await reject("Choose the individual this document belongs to.");
        if (kind === "payroll" && (!employee || individual)) return await reject("Choose the employee this document belongs to.");
        if (kind === "settlements" && !individual && !employee) return await reject("Choose the document's individual or employee.");
        if (individual) {
          if (!(await client.query(`SELECT 1 FROM individuals WHERE id = $1`, [individual])).rows.length) return await reject("Choose an existing individual.");
          context.individualId = individual;
        }
        if (employee) {
          if (!(await client.query(`SELECT 1 FROM employees WHERE id = $1`, [employee])).rows.length) return await reject("Choose an existing employee.");
          context.employeeId = employee;
        }
      }
      await client.query(`UPDATE documents SET access_context = $2::jsonb, updated_by_user_id = $3, updated_at = now() WHERE id = $1`, [documentId, JSON.stringify(context), access.user.id]);
      await recordChange(client, { actorId: access.user.id, action: "document_classified", entityType: "document", entityId: documentId, previous: document.rows[0].access_context, next: context });
    } else if (input.action === "revoke") {
      if (typeof input.userId !== "string" || !DOCUMENT_UUID.test(input.userId)) return await reject("Choose an existing recipient.");
      await client.query(`DELETE FROM document_publications WHERE document_id = $1 AND user_id = $2`, [documentId, input.userId]);
      await recordChange(client, { actorId: access.user.id, action: "document_publication_revoked", entityType: "document", entityId: documentId, extra: { recipientUserId: input.userId } });
    } else if (input.action === "publish") {
      if (input.reviewedSanitizedOutput !== true) return await reject("Review the sanitized PDF and approve its contents for this recipient.");
      const userId = typeof input.userId === "string" ? input.userId : "";
      const versionId = typeof input.versionId === "string" ? input.versionId : "";
      if (!DOCUMENT_UUID.test(userId) || !DOCUMENT_UUID.test(versionId)) return await reject("Choose a recipient and a saved version.");
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title || title.length > 180) return await reject("Enter a safe recipient-facing title, up to 180 characters.");
      const required = Array.isArray(input.requiredCapabilities) ? [...new Set(input.requiredCapabilities)] : [];
      if (!required.length || !required.every((capability): capability is string => typeof capability === "string" && isPortalCapability(capability)
        && /^(hours_budgets|dollar_budgets|employee_pay|employee_checks|employee_giveback|financials|settlements|schedules)\./.test(capability))) {
        return await reject("Choose every data category contained in the approved output.");
      }
      const idValue = (key: string) => typeof input[key] === "string" && DOCUMENT_UUID.test(input[key]) ? input[key] as string : null;
      const publication: DocumentPublication = {
        document_id: documentId, user_id: userId, version_id: versionId, title,
        individual_id: idValue("individualId"), employee_id: idValue("employeeId"), agency_id: idValue("agencyId"),
        scope_date: typeof input.scopeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.scopeDate) ? input.scopeDate : null,
        required_capabilities: required,
      };
      if (Number(Boolean(publication.individual_id)) + Number(Boolean(publication.employee_id)) !== 1) return await reject("Choose exactly one linked individual or employee.");
      if (Boolean(publication.agency_id) !== Boolean(publication.scope_date)) return await reject("Agency documents require a source date.");
      const recipient = await client.query(`SELECT 1 FROM users WHERE id = $1 AND is_active = true`, [userId]);
      const version = await client.query(`SELECT 1 FROM document_versions WHERE document_id = $1 AND id = $2 AND export_mode = 'secure'`, [documentId, versionId]);
      if (!recipient.rows.length || !version.rows.length || document.rows[0].status !== "active") return await reject("Choose an active recipient and a secure saved output from this active document.");
      const portal = await resolvePortalAccess(access.pool, { id: userId });
      if (!await canReadPublication({ ...access, user: { ...access.user, id: userId }, portal }, publication)) {
        return await reject("The recipient needs an explicit document grant and every selected category for this person or agency.");
      }
      const sourceFile = await getDocumentVersionFile(access.pool, documentId, versionId);
      if (!sourceFile) return await reject("That saved PDF was not found.");
      let sanitized;
      try { sanitized = await sanitizePdfPublication(await readDocumentBytesForPublication(sourceFile.pathname)); }
      catch { return await reject("This PDF could not be safely approved. Save a fresh Sanitized flattened PDF in the editor, review it, and try again."); }
      if (sanitized.bytes.byteLength === 0 || sanitized.bytes.byteLength > 100 * 1024 * 1024) return await reject("The approved PDF is too large. Split it into smaller documents.");
      if (!(await client.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'admin' AND is_active`, [access.user.id])).rows.length) {
        return await reject("Owner access is no longer available.");
      }
      const pathname = `documents/${documentId}/publications/${randomUUID()}.pdf`;
      await writePrivateDocumentPublication(pathname, sanitized.bytes);
      uploadedPathname = pathname;
      publication.sanitized_pathname = pathname;
      publication.sanitized_byte_size = sanitized.bytes.byteLength;
      publication.sanitized_sha256 = createHash("sha256").update(sanitized.bytes).digest("hex");
      publication.sanitizer_version = 1;
      await client.query(
        `INSERT INTO document_publications (document_id, user_id, version_id, title, individual_id, employee_id, agency_id, scope_date, required_capabilities, approved_by_user_id,
            sanitized_pathname, sanitized_byte_size, sanitized_sha256, sanitizer_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)
          ON CONFLICT (document_id, user_id) DO UPDATE SET version_id = EXCLUDED.version_id, title = EXCLUDED.title,
            individual_id = EXCLUDED.individual_id, employee_id = EXCLUDED.employee_id, agency_id = EXCLUDED.agency_id,
            scope_date = EXCLUDED.scope_date, required_capabilities = EXCLUDED.required_capabilities, approved_by_user_id = EXCLUDED.approved_by_user_id, approved_at = now(),
            sanitized_pathname = EXCLUDED.sanitized_pathname, sanitized_byte_size = EXCLUDED.sanitized_byte_size,
            sanitized_sha256 = EXCLUDED.sanitized_sha256, sanitizer_version = 1`,
        [documentId, userId, versionId, title, publication.individual_id, publication.employee_id, publication.agency_id, publication.scope_date, required, access.user.id,
          publication.sanitized_pathname, publication.sanitized_byte_size, publication.sanitized_sha256],
      );
      await recordChange(client, { actorId: access.user.id, action: "document_output_approved", entityType: "document", entityId: documentId, next: publication });
    } else return await reject("Choose classify, publish, or revoke.");
    await client.query("COMMIT");
    return ok({ updated: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (uploadedPathname) await deletePrivateDocumentBlob(uploadedPathname).catch(() => undefined);
    throw error;
  }
  finally { client.release(); }
}
