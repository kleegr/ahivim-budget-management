import { requireUser } from "@/lib/auth/session";
import { listUsersWithAccess } from "@/lib/auth/users";
import { buildRolePreviewAccounts } from "@/lib/auth/role-preview";
import { withDb } from "@/lib/data/pool";
import {
  listEmployeePortalAssignments,
  listIndividualPortalAssignments,
} from "@/lib/manage/portal-identities";
import { listAgencies, listAgencyUserAccess } from "@/lib/manage/agencies";
import RolePreviewCenter from "@/components/settings/role-preview-center";
import { ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Role Preview - Ahivim Budget Management" };

function appendName(map: Map<string, string[]>, userId: string, name: string) {
  const names = map.get(userId) ?? [];
  if (!names.includes(name)) names.push(name);
  map.set(userId, names);
}

export default async function RolePreviewPage() {
  const owner = await requireUser("admin");
  const result = await withDb(async (pool) => {
    const [users, individualAssignments, employeeAssignments, agencies] = await Promise.all([
      listUsersWithAccess(pool),
      listIndividualPortalAssignments(pool),
      listEmployeePortalAssignments(pool),
      listAgencies(pool),
    ]);
    const activeAgencies = agencies.filter((agency) => agency.status === "active");
    const agencyAssignments = await Promise.all(
      activeAgencies.map(async (agency) => ({
        agency,
        access: await listAgencyUserAccess(pool, agency.id),
      })),
    );

    const individualNamesByUser = new Map<string, string[]>();
    for (const assignment of individualAssignments) {
      if (assignment.isActive) appendName(individualNamesByUser, assignment.userId, assignment.individualName);
    }
    const employeeNamesByUser = new Map<string, string[]>();
    for (const assignment of employeeAssignments) {
      if (assignment.isActive) appendName(employeeNamesByUser, assignment.userId, assignment.employeeName);
    }
    const agenciesByUser = new Map<string, Array<{
      name: string;
      role: string;
      individualCount: number;
      employeeCount: number;
    }>>();
    for (const { agency, access } of agencyAssignments) {
      for (const assignment of access) {
        if (!assignment.isActive) continue;
        const linked = agenciesByUser.get(assignment.userId) ?? [];
        linked.push({
          name: agency.name,
          role: assignment.role,
          individualCount: agency.individualCount,
          employeeCount: agency.employeeCount,
        });
        agenciesByUser.set(assignment.userId, linked);
      }
    }

    return buildRolePreviewAccounts(users, owner.id, {
      individualNamesByUser,
      employeeNamesByUser,
      agenciesByUser,
    });
  });

  return (
    <>
      <PageHeader
        eyebrow="Owner administration"
        title="Role Preview Center"
        description="Open the real application as an active preset account to inspect its navigation, landing page, and server-enforced data scope. Return to your owner session from the persistent preview bar."
      />
      {!result.ok ? (
        <ErrorPanel title="Could not load role preview accounts">{result.error}</ErrorPanel>
      ) : (
        <RolePreviewCenter accountsByPreset={result.data} />
      )}
    </>
  );
}
