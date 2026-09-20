import {
  DEFAULT_ACL_ROLE_ID,
  NexxusApplication,
  FatalErrorException,
  type INexxusApplication,
  type NexxusAclRole,
} from '@mayhem93/nexxus-core-lib';

import { Command, type CommandArgs, type CommandContext } from '../cli/Command.ts';
import { buildAclRole } from '../cli/aclRole.ts';

import type { ArgumentParser } from 'argparse';

/** Parsed args for `app` (`action` is the chosen subcommand). */
interface AppArgs extends CommandArgs {
  action: 'create';
  payload: string;
  roles?: string;
}

/**
 * `app` — manage Nexxus applications. `create` builds a NexxusApplication from a
 * JSON payload, provisions its per-app storage, then persists it — optionally
 * alongside the ACL roles its user types reference. Further actions
 * (list/show/delete) become additional subparsers dispatched below.
 */
export class AppCommand extends Command<AppArgs> {
  protected readonly name = 'app';
  protected readonly description = 'Manage Nexxus applications.';

  protected configure(parser: ArgumentParser): void {
    const actions = parser.add_subparsers({ dest: 'action', required: true, metavar: '<action>' });

    const create = actions.add_parser('create', { help: 'Create an application from a JSON payload.' });

    create.add_argument('--payload', {
      required: true,
      metavar: '<json|path>',
      help: "Application definition: an inline JSON object ('{...}') or a path to a .json file (bare path or file:// URL).",
    });

    create.add_argument('--roles', {
      metavar: '<json|path>',
      help: "ACL roles to create with the application: an inline JSON array ('[...]') or a path to a .json file. "
        + 'Required for any role the application\'s user types reference. Only valid when "auth.acl" is true.',
    });
  }

  public async execute(ctx: CommandContext<AppArgs>): Promise<void> {
    switch (ctx.args.action) {
      case 'create':
        await this.createApp(ctx);
        break;

      default:
        throw new FatalErrorException(`Unknown app action: ${String(ctx.args.action)}`);
    }
  }

  private async createApp(ctx: CommandContext<AppArgs>): Promise<void> {
    const app = this.buildApplication(ctx.args.payload);

    // Roles are built from the constructed application: they need its generated
    // id for `appId`, and its schema to validate their statements against.
    const roles = this.buildRoles(ctx.args.roles, app);

    this.assertRoleReferencesResolve(app, roles);

    // Provision per-app storage first (idempotent). For an ACL-enabled app this
    // is also what creates the `acl` index the roles below are written to.
    await ctx.database.getBootstrapper().onApplicationCreated(app);

    // Roles BEFORE the Application document, which stays the commit point: the
    // app only becomes visible once everything it references exists. The two
    // are circularly dependent (user types name roles, roles carry the appId),
    // and a dangling role reference is not a soft failure — `loadAclRoles`
    // turns it into a FatalErrorException at boot, taking down every node in
    // the deployment rather than just this app. A bulk write wouldn't help
    // (it isn't atomic), so ordering is the guarantee.
    if (roles.length > 0) {
      await ctx.database.createItems(roles);
    }

    // createItems is not idempotent — re-creating an existing id overwrites it.
    await ctx.database.createItems([app]);

    const created = `Application created: ${app.getData().id}`;

    ctx.logger.info(roles.length > 0 ? `${created} (${roles.length} ACL role(s))` : created, 'NxxCli');
  }

  private buildApplication(raw: string): NexxusApplication {
    const payload = this.resolveJsonObjectArgument<INexxusApplication>(raw, '--payload');

    try {
      return new NexxusApplication(payload);
    } catch (err) {
      // The constructor validates the whole payload and throws plain Errors —
      // wrap them so a bad payload exits as a clean CLI failure rather than an
      // unhandled rejection, matching how role payloads are handled.
      throw new FatalErrorException(`--payload: ${(err as Error).message}`);
    }
  }

  /**
   * Builds the roles supplied via `--roles`, or none when the flag is absent.
   */
  private buildRoles(raw: string | undefined, app: NexxusApplication): NexxusAclRole[] {
    if (raw === undefined) {
      return [];
    }

    if (!app.isAclEnabled()) {
      throw new FatalErrorException(
        '--roles requires the application to enable ACLs ("auth.acl": true) — without it the app has no role storage.'
      );
    }

    const entries = this.resolveJsonArrayArgument(raw, '--roles');
    const roles = entries.map((entry, index) => {
      const where = `--roles entry #${index}`;

      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new FatalErrorException(`${where}: must be a JSON object.`);
      }

      return buildAclRole(entry as Record<string, unknown>, app, where);
    });

    // The document id IS the role name, so duplicates would overwrite each other
    // and quietly leave fewer roles than were declared.
    const seen = new Set<string>();

    for (const role of roles) {
      if (seen.has(role.getName())) {
        throw new FatalErrorException(`--roles declares role "${role.getName()}" more than once.`);
      }

      seen.add(role.getName());
    }

    return roles;
  }

  /**
   * Mirrors the boot-time check in `loadAclRoles`: every role a user type names
   * must resolve. Nothing in the library can enforce this at construction — the
   * Application document and its roles are separate documents referencing each
   * other — so this cross-check is all that stands between a typo here and a
   * fatal error at every node's boot.
   *
   * `DEFAULT_ACL_ROLE_ID` always resolves: it's created in memory at boot, and
   * the Application constructor grants it to the `default` user type. Skipped
   * entirely when ACLs are off, matching the runtime — role references on a
   * non-ACL app are never loaded, so they can't dangle.
   */
  private assertRoleReferencesResolve(app: NexxusApplication, roles: NexxusAclRole[]): void {
    if (!app.isAclEnabled()) {
      return;
    }

    const known = new Set<string>([DEFAULT_ACL_ROLE_ID, ...roles.map(role => role.getName())]);

    for (const [userType, config] of Object.entries(app.getUserTypes() ?? {})) {
      for (const roleName of config.roles ?? []) {
        if (!known.has(roleName)) {
          throw new FatalErrorException(
            `Application user type "${userType}" references ACL role "${roleName}", which was not supplied via --roles. `
            + 'Add it there, or create the application without the reference and attach the role in a later update.'
          );
        }
      }
    }
  }
}
