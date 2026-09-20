import {
  DEFAULT_ACL_ROLE_ID,
  FatalErrorException,
  NexxusAclRole,
  type INexxusAclRole,
  type NexxusApplication,
} from '@mayhem93/nexxus-core-lib';

/**
 * Builds a persistable ACL role for `app` from its JSON representation, and
 * validates it as far as the library allows before anything is written.
 *
 * Two shapes are in play. The JSON a human writes carries `statements` as a real
 * array; the stored document carries it as a JSON string (see the `acl` built-in
 * schema), which `NexxusAclRole` parses straight back at construction. Stringify
 * -> parse looks redundant, but it keeps the CLI's input format readable without
 * bending the storage contract — and role creation is a one-shot admin path, not
 * a hot one.
 *
 * Validation runs in two passes, both inside the library: the constructor does
 * the schema-free structural checks, and `validateAgainstSchema` does the
 * app-dependent ones (resources name real models; condition fields exist, are
 * declared `acl: true`, and are filterable primitives). Both are the same checks
 * the API and workers run at boot, so a role accepted here can't fail there.
 *
 * Shared by `app create --roles` and `acl create` so both paths accept exactly
 * the same role JSON.
 */
export function buildAclRole(payload: Record<string, unknown>, app: NexxusApplication, where: string): NexxusAclRole {
  const appId = app.getData().id as string;

  // The framework default role is created in memory at every boot and a
  // persisted role reusing its name is explicitly ignored (with a warning) by
  // `loadAclRoles` — creating one would be silently inert, so refuse outright.
  if (payload.id === DEFAULT_ACL_ROLE_ID) {
    throw new FatalErrorException(
      `${where}: "${DEFAULT_ACL_ROLE_ID}" is the framework-provided default role and cannot be created — ` +
      `the API and workers ignore any persisted role with that name.`
    );
  }

  // Checked here rather than left to the model: the model expects the stored
  // (string) form, so its own message would name a shape the CLI never accepts.
  if (!Array.isArray(payload.statements)) {
    throw new FatalErrorException(`${where}: "statements" must be a JSON array.`);
  }

  if (payload.appId !== undefined && payload.appId !== appId) {
    throw new FatalErrorException(
      `${where}: "appId" is "${String(payload.appId)}" but the role is being created for application "${appId}".`
    );
  }

  try {
    const role = new NexxusAclRole({
      ...payload,
      appId,
      statements: JSON.stringify(payload.statements),
    } as INexxusAclRole);

    role.validateAgainstSchema(app);

    return role;
  } catch (err) {
    if (err instanceof FatalErrorException) {
      throw err;
    }

    // Model/validator errors are plain Errors; wrap them so a bad payload exits
    // as a clean CLI failure instead of an unhandled rejection.
    throw new FatalErrorException(`${where}: ${(err as Error).message}`);
  }
}
