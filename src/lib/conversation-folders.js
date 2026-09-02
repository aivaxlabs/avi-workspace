export const FOLDER_GROUP_LIMIT = 5;

export function folderDisplayName(path, fallback = '') {
  const value = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : '';
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback;
}

export function buildFolderNavigation(folders, conversations) {
  const descriptors = new Map();
  for (const folder of folders ?? []) {
    if (!folder?.path) continue;
    descriptors.set(folder.path, { ...folder });
  }

  const topLevel = (conversations ?? []).filter((conversation) => !conversation.parentConversationId);
  for (const conversation of topLevel) {
    if (!conversation.projectPath || descriptors.has(conversation.projectPath)) continue;
    const displayPath = conversation.projectDisplayPath ?? conversation.projectPath;
    descriptors.set(conversation.projectPath, {
      path: conversation.projectPath,
      name: conversation.projectName ?? folderDisplayName(displayPath, displayPath),
      displayPath,
      gitBranch: conversation.gitBranch ?? null,
      color: null,
    });
  }

  const groups = [...descriptors.values()].map((folder) => {
    const items = topLevel.filter((conversation) => conversation.projectPath === folder.path);
    const isHome = folder.name === '~/' || folder.displayPath === '~/' || folder.displayPath === '~';
    return {
      key: `folder:${folder.path}`,
      path: folder.path,
      label: isHome ? 'Chats' : folderDisplayName(folder.displayPath ?? folder.path ?? folder.name, folder.name),
      displayPath: folder.displayPath,
      color: folder.color ?? null,
      isHome,
      items,
      latestTime: Math.max(0, ...items.map((conversation) => Date.parse(conversation.updatedAt) || 0)),
    };
  });

  const unassigned = topLevel.filter((conversation) => !conversation.projectPath);
  if (unassigned.length) {
    const home = groups.find((group) => group.isHome);
    if (home) {
      home.items.push(...unassigned);
      home.latestTime = Math.max(home.latestTime, ...unassigned.map((conversation) => Date.parse(conversation.updatedAt) || 0));
    } else {
      groups.push({
        key: 'folder:unassigned',
        path: null,
        label: 'Chats',
        displayPath: 'Default working folder',
        color: null,
        isHome: true,
        items: unassigned,
        latestTime: Math.max(0, ...unassigned.map((conversation) => Date.parse(conversation.updatedAt) || 0)),
      });
    }
  }

  const visibleGroups = groups.filter((group) => group.items.length).sort((left, right) => (
    Number(left.isHome) - Number(right.isHome)
    || right.latestTime - left.latestTime
    || left.label.localeCompare(right.label)
  ));
  const choices = groups.filter((group) => group.path || group.isHome).sort((left, right) => (
    Number(left.isHome) - Number(right.isHome)
    || left.label.localeCompare(right.label)
  ));

  if (!choices.length) {
    choices.push({ key: 'folder:default', path: null, label: 'Chats', displayPath: 'Default working folder', isHome: true });
  }

  return { groups: visibleGroups, choices };
}

export function conversationCreateParams(folder, model) {
  return {
    ...(model ? { model } : {}),
    ...(folder?.path && !folder.isHome ? { projectPath: folder.path } : {}),
  };
}
