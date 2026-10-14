/**
 * Feishu Contact API lookup: resolve a user's department names and job title
 * for role-based permission mapping. Results are cached per user with a TTL
 * to avoid calling the API on every message.
 *
 * Required bot scope: `contact:user.base:readonly` + `contact:department.base:readonly`.
 * Falls back gracefully (returns undefined) when the scope is missing or the
 * API call fails — rolePermissions simply won't match, and the user resolves
 * via the normal defaultAccess chain.
 */
import type { LarkChannel } from '@larksuite/channel';

export interface FeishuUserRole {
  departmentNames: string[];
  jobTitle: string;
}

interface CacheEntry {
  role: FeishuUserRole;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map<string, CacheEntry>();

interface FeishuUserResponse {
  data?: {
    user?: {
      department_ids?: string[];
      job_title_id?: string;
      enterprise_email?: string;
    };
  };
}

interface FeishuDeptResponse {
  data?: {
    department?: {
      name?: string;
    };
  };
}

async function callApi(
  channel: LarkChannel,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const token = await (channel as unknown as { getTenantAccessToken?: () => Promise<string> }).getTenantAccessToken?.();
    if (!token) return undefined;
    const resp = await fetch(`https://open.feishu.cn${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return undefined;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Look up a user's department names and job title from the Feishu Contact
 * API. Cached for 1 hour per open_id.
 */
export async function getUserRole(
  channel: LarkChannel,
  openId: string,
): Promise<FeishuUserRole | undefined> {
  const cached = cache.get(openId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.role;
  }

  // Fetch user info
  const userInfo = (await callApi(
    channel,
    `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
  )) as FeishuUserResponse | undefined;

  if (!userInfo?.data?.user) return undefined;

  const deptIds = userInfo.data.user.department_ids ?? [];
  const jobTitleId = userInfo.data.user.job_title_id;

  // Fetch department names in parallel
  const deptNames: string[] = [];
  await Promise.all(
    deptIds.slice(0, 5).map(async (id) => {
      const dept = (await callApi(
        channel,
        `/open-apis/contact/v3/departments/${encodeURIComponent(id)}`,
      )) as FeishuDeptResponse | undefined;
      if (dept?.data?.department?.name) {
        deptNames.push(dept.data.department.name);
      }
    }),
  );

  const role: FeishuUserRole = {
    departmentNames: deptNames,
    jobTitle: jobTitleId ?? '',
  };

  cache.set(openId, { role, expiresAt: Date.now() + CACHE_TTL_MS });
  return role;
}

/** Clear the cache (for testing or admin force-refresh). */
export function clearUserRoleCache(): void {
  cache.clear();
}
