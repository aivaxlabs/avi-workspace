import { useEffect, useRef, useState } from 'preact/hooks';
import { ConnectionsPage } from './components/ConnectionsPage.jsx';
import { WorkspacePage } from './components/WorkspacePage.jsx';
import { METHODS, normalizeModelsResult, supportsMethod, validateDiscovery } from './rpc/contracts.js';
import { RpcClient } from './rpc/client.js';
import { toWebSocketUrl } from './rpc/url.js';

async function loadWorkspaceState(client, discovery, includeModels = false) {
  const [conversations, folders, botsResult, tagsResult, sidebarStatus, modelCatalog] = await Promise.all([
    client.request(METHODS.listConversations),
    client.request(METHODS.listFolders),
    supportsMethod(discovery, METHODS.listBots) ? client.request(METHODS.listBots) : null,
    supportsMethod(discovery, METHODS.listTags) ? client.request(METHODS.listTags) : null,
    supportsMethod(discovery, METHODS.sidebarStatus) ? client.request(METHODS.sidebarStatus) : null,
    includeModels ? client.request(METHODS.models).then(normalizeModelsResult) : null,
  ]);
  return {
    conversations,
    folders,
    bots: botsResult?.bots ?? [],
    botWorkState: botsResult?.workStateByBot ?? {},
    schedulerSnooze: botsResult?.schedulerSnooze ?? { active: false, mode: null, until: null },
    tags: tagsResult?.tags ?? [],
    sidebarStatus: sidebarStatus ?? {
      runningConversationIds: [],
      approvalPendingConversationIds: [],
      inputPendingConversationIds: [],
      semaphoreWaitingConversationIds: [],
      completedUnseenConversationIds: [],
    },
    ...(modelCatalog ? {
      models: modelCatalog.models,
      messageDeliveryMode: modelCatalog.messageDeliveryMode,
    } : {}),
  };
}

export function App() {
  const [statuses, setStatuses] = useState({});
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;

  async function openGlobal(connection, persistent = true) {
    const client = new RpcClient({ url: toWebSocketUrl(connection.serverUrl), apiKey: connection.apiKey, reconnect: persistent, timeoutMs: 8_000 });
    try {
      await client.connect();
      const discovery = validateDiscovery(await client.request(METHODS.discover));
      const workspaceState = await loadWorkspaceState(client, discovery, true);
      return { connection, client, discovery, ...workspaceState, pendingConversations: [] };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async function check(connection) {
    setStatuses((current) => ({ ...current, [connection.id]: { status: 'checking', detail: 'Checking RPC API...' } }));
    let result;
    try {
      const checked = await openGlobal(connection, false);
      checked.client.close();
      result = { status: 'online', detail: `Avi ${checked.discovery.appVersion} · RPC v${checked.discovery.apiVersion}` };
    } catch (error) { result = { status: 'offline', detail: error.message }; }
    setStatuses((current) => ({ ...current, [connection.id]: result }));
  }

  async function enter(connection) {
    const next = await openGlobal(connection);
    next.client.addEventListener('status', (event) => setStatuses((current) => ({ ...current, [connection.id]: event.detail })));
    setSession(next);
  }
  async function refresh(createdConversation = null) {
    const current = sessionRef.current;
    if (!current?.client) return;
    const workspaceState = await loadWorkspaceState(current.client, current.discovery, true);
    const listedConversations = workspaceState.conversations;
    const pending = createdConversation
      ? [createdConversation, ...(current.pendingConversations ?? []).filter((item) => item.id !== createdConversation.id)]
      : current.pendingConversations ?? [];
    const listedIds = new Set(listedConversations.map((item) => item.id));
    const pendingConversations = pending.filter((item) => !listedIds.has(item.id));
    const conversations = [...pendingConversations, ...listedConversations];
    setSession({ ...current, ...workspaceState, conversations, pendingConversations });
  }
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => refresh().catch(() => {}), 5_000);
    return () => clearInterval(timer);
  }, [session?.connection.id]);
  function exit() { session?.client.close(); setSession(null); }

  return session
    ? <WorkspacePage {...session} globalClient={session.client} onRefresh={refresh} onExit={exit} />
    : <ConnectionsPage statuses={statuses} onCheck={check} onEnter={(connection) => enter(connection).catch((error) => setStatuses((current) => ({ ...current, [connection.id]: { status: 'offline', detail: error.message } })))} />;
}
