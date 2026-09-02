export const initialUiState = Object.freeze({
  sidebarCollapsed: false,
  auxiliaryOpen: true,
  auxiliaryWidth: 360,
  auxiliaryTab: 'tasks',
  activeConversationId: null,
});

export function uiReducer(state, action) {
  switch (action.type) {
    case 'sidebar:toggle': return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'auxiliary:toggle': return { ...state, auxiliaryOpen: !state.auxiliaryOpen };
    case 'auxiliary:resize': return { ...state, auxiliaryWidth: Math.max(280, Number(action.width) || 280) };
    case 'auxiliary:tab': return { ...state, auxiliaryTab: action.tab, auxiliaryOpen: true };
    case 'conversation:select': return { ...state, activeConversationId: action.id };
    default: return state;
  }
}
