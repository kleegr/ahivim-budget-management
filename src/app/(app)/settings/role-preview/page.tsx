import { requireUser } from "@/lib/auth/session";
import { listUsersWithAccess } from "@/lib/auth/users";
import { buildRolePreviewAccounts } from "@/lib/auth/role-preview";
import { withDb } from "@/lib/data/pool";
import {
  listEmployeePortalAssignments,
  listGlobalPortalRoleAssignments,
  listIndividualPortalAssignments,
} from "@/lib/manage/portal-identities";
import { listAgencies, listAgencyUserAccess } from "@/lib/manage/agencies";
import {
  portalCapabilityAllowedForRole,
  type PortalAccessContext,
  type PortalCapability,
  type PortalRole,
} from "@/lib/auth/portal-access";
import RolePreviewCenter from "@/components/settings/role-preview-center";
import { ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Role Preview - Ahivim Budget Management" };

function appendName(map: Map<string, string[]>, userId: string, name: string) {
  const names = map.get(userId) ?? [];
  if (!names.includes(name)) names.push(name);
  map.set(userId, names);
}

function effectivePolicy(
  role: PortalRole,
  grants: readonly PortalCapability[],
  denials: readonly PortalCapability[],
) {
  return {
    grants: grants.filter((capability) => portalCapabilityAllowedForRole(role, capability)),
    denials: denials.filter((capability) => portalCapabilityAllowedForRole(role, capability)),
  };
}

export default async function RolePreviewPage() {
  const owner = await requireUser("admin");
  const result = await withDb(async (pool) => {
    const [users, globalAssignments, individualAssignments, employeeAssignments, agencies] = await Promise.all([
      listUsersWithAccess(pool),
      listGlobalPortalRoleAssignments(pool),
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

    const portalAccessByUser = new Map<string, PortalAccessContext>();
    const portalAccessFor = (userId: string) => {
      const existing = portalAccessByUser.get(userId);
      if (existing) return existing;
      const created: PortalAccessContext = {
        userId,
        globalRoles: [],
        agencyAccess: [],
        individualLinks: [],
        employeeLinks: [],
      };
      portalAccessByUser.set(userId, created);
      return created;
    };

    for (const assignment of globalAssignments) {
      if (!assignment.isActive) continue;
      portalAccessFor(assignment.userId).globalRoles.push({
        role: assignment.role,
        ...effectivePolicy(
          assignment.role,
          assignment.capabilityGrants,
          assignment.capabilityDenials,
        ),
      });
    }

    const individualNamesByUser = new Map<string, string[]>();
    const individualNameById = new Map<string, string>();
    for (const assignment of individualAssignments) {
      individualNameById.set(assignment.individualId, assignment.individualName);
      if (!assignment.isActive) continue;
      appendName(individualNamesByUser, assignment.userId, assignment.individualName);
      const role = assignment.relationship === "self" ? "individual" : "parent";
      portalAccessFor(assignment.userId).individualLinks.push({
        individualId: assignment.individualId,
        relationship: assignment.relationship,
        ...effectivePolicy(
          role,
          assignment.capabilityGrants,
          assignment.capabilityDenials,
        ),
      });
    }
    const employeeNamesByUser = new Map<string, string[]>();
    const employeeNameById = new Map<string, string>();
    for (const assignment of employeeAssignments) {
      employeeNameById.set(assignment.employeeId, assignment.employeeName);
      if (!assignment.isActive) continue;
      appendName(employeeNamesByUser, assignment.userId, assignment.employeeName);
      portalAccessFor(assignment.userId).employeeLinks.push({
        employeeId: assignment.employeeId,
        relationship: "self",
        ...effectivePolicy(
          "employee",
          assignment.capabilityGrants,
          assignment.capabilityDenials,
        ),
      });
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
        portalAccessFor(assignment.userId).agencyAccess.push({
          agencyId: agency.id,
          agencyCode: agency.code,
          agencyName: agency.name,
          role: assignment.role,
          ...effectivePolicy(
            assignment.role,
            assignment.capabilityGrants,
            assignment.capabilityDenials,
          ),
        });
      }
    }

    return buildRolePreviewAccounts(users, owner.id, {
      individualNamesByUser,
      employeeNamesByUser,
      agenciesByUser,
      portalAccessByUser,
      individualNameById,
      employeeNameById,
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
