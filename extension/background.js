// 툴바 아이콘을 누르면 사이드패널이 열리도록 설정
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// content script가 자기 탭 번호를 알 수 있게 알려 준다 (새로고침 후 이어서 실행할 때 사용).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'whoami') sendResponse({ tabId: sender.tab ? sender.tab.id : null });
});
