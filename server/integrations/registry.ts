import type {
  IntegrationActionDescriptor,
  IntegrationAppDescriptor,
  IntegrationAppId,
} from "./types.js";

export class IntegrationRegistry {
  private readonly apps = new Map<string, IntegrationAppDescriptor<string>>();

  register<TAppId extends string>(descriptor: IntegrationAppDescriptor<TAppId>): this {
    assertDescriptor(descriptor);
    if (this.apps.has(descriptor.id)) {
      throw new TypeError(`O app ${descriptor.id} já está registrado.`);
    }
    this.apps.set(descriptor.id, freezeDescriptor(descriptor));
    return this;
  }

  listApps(): readonly IntegrationAppDescriptor<string>[] {
    return [...this.apps.values()];
  }

  getApp<TAppId extends string = IntegrationAppId>(
    appId: TAppId,
  ): IntegrationAppDescriptor<TAppId> | null {
    return (this.apps.get(appId) as IntegrationAppDescriptor<TAppId> | undefined) ?? null;
  }

  getAction(
    appId: string,
    actionId: string,
  ): IntegrationActionDescriptor<string> | null {
    return this.apps.get(appId)?.actions.find((action) => action.id === actionId) ?? null;
  }
}
function assertDescriptor(descriptor: IntegrationAppDescriptor<string>): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(descriptor.id)) {
    throw new TypeError("Identificador de app inválido.");
  }
  if (!descriptor.name.trim() || !descriptor.description.trim()) {
    throw new TypeError("Nome e descrição do app são obrigatórios.");
  }
  if (descriptor.actions.length === 0) {
    throw new TypeError("O app precisa declarar ao menos uma ação.");
  }
  const actionIds = new Set<string>();
  for (const action of descriptor.actions) {
    if (action.appId !== descriptor.id) {
      throw new TypeError("A ação precisa pertencer ao app registrado.");
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(action.id) || actionIds.has(action.id)) {
      throw new TypeError("Identificador de ação inválido ou duplicado.");
    }
    if (!descriptor.capabilities.includes(action.capability)) {
      throw new TypeError("A ação usa uma capacidade não declarada pelo app.");
    }
    actionIds.add(action.id);
  }
}

function freezeDescriptor<TAppId extends string>(
  descriptor: IntegrationAppDescriptor<TAppId>,
): IntegrationAppDescriptor<TAppId> {
  const actions = descriptor.actions.map((action) => Object.freeze({ ...action }));
  return Object.freeze({
    ...descriptor,
    capabilities: Object.freeze([...descriptor.capabilities]),
    actions: Object.freeze(actions),
  });
}
