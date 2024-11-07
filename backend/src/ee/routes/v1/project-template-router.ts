import slugify from "@sindresorhus/slugify";
import { z } from "zod";

import { ProjectMembershipRole, ProjectTemplatesSchema } from "@app/db/schemas";
import { EventType } from "@app/ee/services/audit-log/audit-log-types";
import { ProjectPermissionV2Schema } from "@app/ee/services/permission/project-permission";
import {
  DefaultProjectTemplateIdentifier,
  ProjectTemplateDefaultEnvironments
} from "@app/ee/services/project-template/project-template-constants";
import { ProjectTemplates } from "@app/lib/api-docs";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { UnpackedPermissionSchema } from "@app/server/routes/santizedSchemas/permission";
import { AuthMode } from "@app/services/auth/auth-type";

const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((val) => val.toLowerCase() === val, "Must be lowercase")
  .refine((v) => slugify(v) === v, {
    message: "Must be valid slug format"
  });

const isReservedRoleSlug = (slug: string) =>
  Object.values(ProjectMembershipRole).includes(slug as ProjectMembershipRole);

const isReservedRoleName = (name: string) =>
  ["custom", "admin", "viewer", "developer", "no access"].includes(name.toLowerCase());

const SanitizedProjectTemplateSchema = ProjectTemplatesSchema.extend({
  roles: z
    .object({
      name: z.string().trim().min(1),
      slug: SlugSchema,
      permissions: UnpackedPermissionSchema.array()
    })
    .array(),
  environments: z
    .object({
      name: z.string().trim().min(1),
      slug: SlugSchema,
      position: z.number().min(1)
    })
    .array()
});

const ProjectTemplateRolesSchema = z
  .object({
    name: z.string().trim().min(1),
    slug: SlugSchema,
    permissions: ProjectPermissionV2Schema.array()
  })
  .array()
  .superRefine((roles, ctx) => {
    if (!roles.length) return;

    if (new Set(roles.map((v) => v.slug)).size !== roles.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Role slugs must be unique" });

    if (new Set(roles.map((v) => v.name)).size !== roles.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Role names must be unique" });

    roles.forEach((role) => {
      if (isReservedRoleSlug(role.slug))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Role slug "${role.slug}" is reserved` });

      if (isReservedRoleName(role.name))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Role name "${role.name}" is reserved` });
    });
  });

const ProjectTemplateEnvironmentsSchema = z
  .object({
    name: z.string().trim().min(1),
    slug: SlugSchema,
    position: z.number().min(1)
  })
  .array()
  .min(1)
  .superRefine((environments, ctx) => {
    if (new Set(environments.map((v) => v.name)).size !== environments.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Environment names must be unique" });

    if (new Set(environments.map((v) => v.slug)).size !== environments.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Environment slugs must be unique" });

    if (
      environments.some((env) => env.position < 1 || env.position > environments.length) ||
      new Set(environments.map((env) => env.position)).size !== environments.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "One or more of the positions specified is invalid. Positions must be sequential starting from 1."
      });
  });

export const registerProjectTemplateRouter = async (server: FastifyZodProvider) => {
  server.route({
    method: "GET",
    url: "/",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "List project templates for the current organization.",
      response: {
        200: z.object({
          projectTemplates: SanitizedProjectTemplateSchema.array()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const projectTemplates = await server.services.projectTemplate.listProjectTemplatesByOrg(req.permission);

      const auditTemplates = projectTemplates.filter((template) => template.name !== DefaultProjectTemplateIdentifier);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: req.permission.orgId,
        event: {
          type: EventType.GET_PROJECT_TEMPLATES,
          metadata: {
            count: auditTemplates.length,
            templateIds: auditTemplates.map((template) => template.id)
          }
        }
      });

      return { projectTemplates };
    }
  });

  server.route({
    method: "GET",
    url: "/:templateId",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "Get a project template by ID.",
      params: z.object({
        templateId: z.string().uuid()
      }),
      response: {
        200: z.object({
          projectTemplate: SanitizedProjectTemplateSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const projectTemplate = await server.services.projectTemplate.findProjectTemplatesById(
        req.params.templateId,
        req.permission
      );

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: req.permission.orgId,
        event: {
          type: EventType.GET_PROJECT_TEMPLATE,
          metadata: {
            templateId: req.params.templateId
          }
        }
      });

      return { projectTemplate };
    }
  });

  server.route({
    method: "POST",
    url: "/",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Create a project template.",
      body: z.object({
        name: SlugSchema.refine((val) => val !== DefaultProjectTemplateIdentifier, {
          message: `The project template name "${DefaultProjectTemplateIdentifier}" is reserved.`
        }).describe(ProjectTemplates.CREATE.name),
        description: z.string().trim().optional().describe(ProjectTemplates.CREATE.description),
        roles: ProjectTemplateRolesSchema.default([]).describe(ProjectTemplates.CREATE.roles),
        environments: ProjectTemplateEnvironmentsSchema.default(ProjectTemplateDefaultEnvironments).describe(
          ProjectTemplates.CREATE.environments
        )
      }),
      response: {
        200: z.object({
          projectTemplate: SanitizedProjectTemplateSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const projectTemplate = await server.services.projectTemplate.createProjectTemplate(req.body, req.permission);

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: req.permission.orgId,
        event: {
          type: EventType.CREATE_PROJECT_TEMPLATE,
          metadata: req.body
        }
      });

      return { projectTemplate };
    }
  });

  server.route({
    method: "PATCH",
    url: "/:templateId",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Update a project template.",
      params: z.object({ templateId: z.string().uuid().describe(ProjectTemplates.UPDATE.templateId) }),
      body: z.object({
        name: SlugSchema.refine((val) => val !== DefaultProjectTemplateIdentifier, {
          message: `The project template name "${DefaultProjectTemplateIdentifier}" is reserved.`
        })
          .optional()
          .describe(ProjectTemplates.UPDATE.name),
        description: z.string().trim().optional().describe(ProjectTemplates.UPDATE.description),
        roles: ProjectTemplateRolesSchema.optional().describe(ProjectTemplates.UPDATE.roles),
        environments: ProjectTemplateEnvironmentsSchema.optional().describe(ProjectTemplates.UPDATE.environments)
      }),
      response: {
        200: z.object({
          projectTemplate: SanitizedProjectTemplateSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const projectTemplate = await server.services.projectTemplate.updateProjectTemplateById(
        req.params.templateId,
        req.body,
        req.permission
      );

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: req.permission.orgId,
        event: {
          type: EventType.UPDATE_PROJECT_TEMPLATE,
          metadata: {
            templateId: req.params.templateId,
            ...req.body
          }
        }
      });

      return { projectTemplate };
    }
  });

  server.route({
    method: "DELETE",
    url: "/:templateId",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Delete a project template.",
      params: z.object({ templateId: z.string().uuid().describe(ProjectTemplates.DELETE.templateId) }),

      response: {
        200: z.object({
          projectTemplate: SanitizedProjectTemplateSchema
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      const projectTemplate = await server.services.projectTemplate.deleteProjectTemplateById(
        req.params.templateId,
        req.permission
      );

      await server.services.auditLog.createAuditLog({
        ...req.auditLogInfo,
        orgId: req.permission.orgId,
        event: {
          type: EventType.DELETE_PROJECT_TEMPLATE,
          metadata: {
            templateId: req.params.templateId
          }
        }
      });

      return { projectTemplate };
    }
  });
};
