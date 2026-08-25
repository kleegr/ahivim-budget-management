-- PDF editing is a separate operational capability. It does not imply access
-- to payroll, transactions, class revenue, or any person's financial data.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_edit_documents boolean NOT NULL DEFAULT false;

-- Existing trusted staff retain the document access they had by role. New
-- restricted accounts remain closed until an administrator grants it.
UPDATE users
   SET can_edit_documents = true
 WHERE role IN ('admin', 'manager');
