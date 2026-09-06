import { useEffect, useRef, useState } from 'preact/hooks';
import { ConnectionsPage } from './components/ConnectionsPage.jsx';
import { WorkspacePage } from './components/WorkspacePage.jsx';
import { METHODS, normalizeModelsResult, supportsMethod, validateDiscovery } from './rpc/contracts.js';
import { RpcClient } from './rpc/client.js';
import { toWebSocketUrl } from './rpc/url.js';
import { listConnections } from './storage/connections.js';

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
    conversations, folders,
    bots: botsResult?.bots ?? [],
    botWorkState: botsResult?.workStateByBot ?? {},
    schedulerSnooze: botsResult?.schedulerSnooze ?? { active: false, mode: null, until: null },
    tags: tagsResult?.tags ?? [],
    sidebarStatus: sidebarStatus ?? {
      runningConversationIds: [], approvalPendingConversationIds: [], inputPendingConversationIds: [],
      semaphoreWaitingConversationIds: [], completedUnseenConversationIds: [],
    },
    ...(modelCatalog ? { models: modelCatalog.models, intelligenceLevels: modelCatalog.defaultModels?.intelligence?.levels ?? [], messageDeliveryMode: modelCatalog.messageDeliveryMode } : {}),
  };
}

export function App() {
  const [statuses, setStatuses] = useState({});
  const [session, setSession] = useState(null);
  const [connections, setConnections] = useState([]);
  const [switchingConnectionId, setSwitchingConnectionId] = useState(null);
  const [refreshError, setRefreshError] = useState('');
  const sessionRef = useRef(null);
  const attempt = useRef(0);
  const pendingClient = useRef(null);
  const probes = useRef(new Map());
  const workspaceMemory = useRef(new Map());

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const syncViewport = () => {
      if (viewport.scale !== 1) return;
      if (!document.activeElement?.matches('input, textarea, [contenteditable="true"]')) {
        for (const property of ['--app-height', '--app-offset-top', '--keyboard-inset']) style.removeProperty(property);
        return;
      }
      style.setProperty('--app-height', `${viewport.height}px`);
      style.setProperty('--app-offset-top', `${viewport.offsetTop}px`);
      style.setProperty('--keyboard-inset', `${Math.max(0, window.innerHeight - viewport.height)}px`);
    };
    syncViewport();
    viewport.addEventListener('resize', syncViewport);
    viewport.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    document.addEventListener('focusin', syncViewport);
    document.addEventListener('focusout', syncViewport);
    return () => {
      viewport.removeEventListener('resize', syncViewport);
      viewport.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
      document.removeEventListener('focusin', syncViewport);
      document.removeEventListener('focusout', syncViewport);
      for (const property of ['--app-height', '--app-offset-top', '--keyboard-inset']) style.removeProperty(property);
    };
  }, []);

  async function check(connection) {
    const previous = probes.current.get(connection.id);
    previous?.close();
    const client = new RpcClient({ url: toWebSocketUrl(connection.serverUrl), apiKey: connection.apiKey, reconnect: false, timeoutMs: 8_000 });
    probes.current.set(connection.id, client);
    setStatuses((current) => ({ ...current, [connection.id]: { status: 'checking', detail: 'Checking RPC API...' } }));
    try {
      await client.connect();
      const discovery = validateDiscovery(await client.request(METHODS.discover));
      if (probes.current.get(connection.id) !== client) return;
      setStatuses((current) => ({ ...current, [connection.id]: { status: 'online', detail: `Avi ${discovery.appVersion} · RPC v${discovery.apiVersion}` } }));
    } catch (error) {
      if (probes.current.get(connection.id) === client) setStatuses((current) => ({ ...current, [connection.id]: { status: 'offline', detail: error.message } }));
    } finally {
      client.close();
      if (probes.current.get(connection.id) === client) probes.current.delete(connection.id);
    }
  }

  async function refresh(createdConversation = null) {
    const current = sessionRef.current;
    if (!current) return;
    if (createdConversation) current.pendingConversations.set(createdConversation.id, createdConversation);
    if (current.refreshing) {
      await current.refreshing;
      if (createdConversation && sessionRef.current === current) return refresh();
      return;
    }
    const pending = (async () => {
      const needsDiscovery = current.needsDiscovery;
      const discovery = needsDiscovery ? validateDiscovery(await current.client.request(METHODS.discover)) : current.discovery;
      const data = await loadWorkspaceState(current.client, discovery, needsDiscovery);
      if (sessionRef.current !== current || current.client.closed) return;
      const listed = new Set(data.conversations.map((item) => item.id));
      for (const id of listed) current.pendingConversations.delete(id);
      Object.assign(current, data, { discovery, needsDiscovery: false, conversations: [...current.pendingConversations.values(), ...data.conversations] });
      setSession({ ...current });
      setRefreshError('');
    })();
    current.refreshing = pending;
    try { await pending; }
    catch (error) { if (sessionRef.current === current) setRefreshError(`Workspace refresh failed: ${error.message}`); throw error; }
    finally { if (current.refreshing === pending) current.refreshing = null; }
  }

  async function enter(connection, availableConnections = connections) {
    if (sessionRef.current?.connection.id === connection.id && !pendingClient.current) return;
    const token = ++attempt.current;
    pendingClient.current?.close();
    const client = new RpcClient({ url: connection.relay ? undefined : toWebSocketUrl(connection.serverUrl), relay: connection.relay, apiKey: connection.apiKey, timeoutMs: 8_000 });
    pendingClient.current = client;
    setSwitchingConnectionId(connection.id);
    setRefreshError('');
    try {
      await client.connect();
      const discovery = validateDiscovery(await client.request(METHODS.discover));
      const data = await loadWorkspaceState(client, discovery, true);
      const saved = await listConnections();
      if (token !== attempt.current) { client.close(); return; }
      const previous = sessionRef.current;
      const next = { connection, client, discovery, ...data, pendingConversations: new Map(), refreshing: null, needsDiscovery: false, connectionStatus: { status: 'online' } };
      sessionRef.current = next;
      client.addEventListener('status', (event) => {
        if (sessionRef.current !== next) return;
        next.connectionStatus = event.detail;
        if (event.detail.status !== 'online') next.needsDiscovery = true;
        setSession({ ...next });
        if (event.detail.status === 'online') refresh().catch(() => {});
      });
      const remotes = availableConnections.filter((item) => item.relay);
      if (connection.relay && !remotes.some((item) => item.id === connection.id)) remotes.push(connection);
      setConnections([...saved, ...remotes]);
      setSession({ ...next });
      previous?.client.close();
      if (previous?.connection.relay) workspaceMemory.current.delete(previous.connection.id);
    } catch (error) {
      client.close();
      if (token !== attempt.current) return;
      setStatuses((current) => ({ ...current, [connection.id]: { status: 'offline', detail: error.message } }));
      if (sessionRef.current) setRefreshError(`Could not open ${connection.label}: ${error.message}`);
    } finally {
      if (token === attempt.current) { pendingClient.current = null; setSwitchingConnectionId(null); }
    }
  }

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => refresh().catch(() => {}), 5_000);
    return () => clearInterval(timer);
  }, [session?.connection.id]);
  useEffect(() => () => {
    attempt.current += 1;
    pendingClient.current?.close();
    const current = sessionRef.current;
    sessionRef.current = null;
    current?.client.close();
    for (const client of probes.current.values()) client.close();
    probes.current.clear();
  }, []);

  function exit() {
    attempt.current += 1;
    pendingClient.current?.close();
    pendingClient.current = null;
    const current = sessionRef.current;
    sessionRef.current = null;
    current?.client.close();
    if (current?.connection.relay) workspaceMemory.current.delete(current.connection.id);
    setSession(null);
    setConnections([]);
    setSwitchingConnectionId(null);
    setRefreshError('');
  }

  return session
    ? <WorkspacePage key={session.connection.id} {...session} globalClient={session.client} connections={connections} onSwitchConnection={enter} connectionStatus={session.connectionStatus} refreshError={refreshError} switchingConnectionId={switchingConnectionId} workspaceMemory={workspaceMemory.current} onRefresh={refresh} onExit={exit} />
    : <ConnectionsPage statuses={statuses} openingId={switchingConnectionId} onCheck={check} onEnter={enter} onCancelOpen={exit} />;
}
