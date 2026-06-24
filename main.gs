// ==========================================
// 0. 사용 전 꼭 읽어주세요
// ==========================================
// 1) TARGET_USER_ID 찾는 법:
//    스포티파이 앱에서 해당 유저 프로필 → 공유 → "프로필 링크 복사"
//    https://open.spotify.com/user/abcd1234?si=... 에서 "abcd1234" 부분이 ID 입니다.
//
// 2) ⚠️ 한계점 (반드시 인지하고 사용하세요):
//    - 이 코드는 헤드리스 브라우저 없이 open.spotify.com/user/{ID} 페이지의
//      "서버에서 미리 렌더링된 부분"만 긁어옵니다(JS 실행 X).
//      실험 결과 이 페이지는 보통 상위 10개 정도의 플레이리스트만 미리 렌더링되고,
//      나머지는 "Show all" 클릭 시 JS로 추가 로딩됩니다. 즉 유저가 프로필에
//      고정해둔 공개 플레이리스트가 10개를 초과하면, 11번째부터는 감지가 안 됩니다.
//    - 더 큰 문제: 만약 이 목록의 정렬 기준이 "최근 수정순"이라면, 안 보이는
//      구간의 플레이리스트를 수정했을 때 그게 갑자기 상위로 올라오면서 다른 플레이리스트가
//      밀려날 수 있습니다. 이 경우 실제로는 삭제되지 않았는데 "삭제됨" 오탐이 뜰 수 있어요.
//      → 감시 대상 유저의 고정 공개 플레이리스트가 10개 이하라면 이 문제는 거의 없습니다.
//    - 스포티파이는 "플레이리스트 공개"와 "프로필에 추가(고정)"를 별개로 취급합니다.
//      프로필에 추가되지 않은 공개 플레이리스트는 이 방식으로 아예 안 보입니다.
//    - 기존 플레이리스트 감시 코드와 마찬가지로 비공식 페이지 구조를 파싱하는 거라,
//      스포티파이가 페이지 구조를 바꾸면 정규식을 손봐야 할 수 있습니다.

// ==========================================
// 1. 환경 변수 및 설정값
// ==========================================
const DISCORD_WEBHOOK_URL = " ";

const TARGET_USER_ID = " "; // 👈 감시할 스포티파이 유저 ID로 교체하세요

const STATE_FILE_NAME = "spotify_user_monitor_state.json";

// ==========================================
// 2. 상태 관리 로직 (구글 드라이브)
// ==========================================
function loadState() {
  const files = DriveApp.getFilesByName(STATE_FILE_NAME);
  if (files.hasNext()) {
    const state = JSON.parse(files.next().getBlob().getDataAsString());
    if (!state.playlists) state.playlists = {};
    return state;
  }
  return { displayName: null, playlists: {} };
}

function saveState(state) {
  const files = DriveApp.getFilesByName(STATE_FILE_NAME);
  const content = JSON.stringify(state);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    DriveApp.createFile(STATE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

// ==========================================
// 3. 재귀적 트랙 + 플레이리스트 메타 추출
// ==========================================
// 플레이리스트 자기 자신(uri가 spotify:playlist:로 시작)을 만나면 이름을 meta에 저장하고,
// 트랙(uri가 spotify:track:로 시작)을 만나면 tracksDict에 저장합니다.
function extractTracksAndMeta(obj, tracksDict, meta) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      extractTracksAndMeta(obj[i], tracksDict, meta);
    }
  } else if (obj !== null && typeof obj === 'object') {
    if (typeof obj.uri === 'string') {
      if (obj.uri.startsWith('spotify:track:')) {
        const trackId = obj.uri.split(':').pop();
        const title = obj.title || obj.name;

        let subtitle = obj.subtitle;
        if (!subtitle && obj.artists && Array.isArray(obj.artists) && obj.artists.length > 0) {
          subtitle = obj.artists[0].name;
        }

        if (title && !tracksDict[trackId]) {
          tracksDict[trackId] = {
            id: trackId,
            name: title,
            artist: subtitle || '알 수 없는 가수',
            link: ["https://", "open", ".spotify.com/track/", trackId].join("")
          };
        }
      } else if (obj.uri.startsWith('spotify:playlist:') && !meta.name) {
        const title = obj.title || obj.name;
        if (title) meta.name = title;
      }
    }

    for (let key in obj) {
      extractTracksAndMeta(obj[key], tracksDict, meta);
    }
  }
}

// 유저 프로필 페이지의 JSON 블록에서 플레이리스트 uri만 모으는 용도 (있을 경우를 대비한 1차 시도)
function extractPlaylistRefs(obj, found) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      extractPlaylistRefs(obj[i], found);
    }
  } else if (obj !== null && typeof obj === 'object') {
    if (typeof obj.uri === 'string' && obj.uri.startsWith('spotify:playlist:')) {
      const id = obj.uri.split(':').pop();
      if (!found[id]) found[id] = true;
    }
    for (let key in obj) {
      extractPlaylistRefs(obj[key], found);
    }
  }
}

// ==========================================
// 4. 플레이리스트 임베드 파싱 (이름 + 트랙)
// ==========================================
function fetchPlaylistViaEmbed(playlistId) {
  const embedUrl = ["https://", "open", ".spotify.com/embed/playlist/", playlistId].join("");

  const options = {
    method: "get",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(embedUrl, options);
  if (response.getResponseCode() !== 200) {
    return null;
  }

  const html = response.getContentText();
  const regex = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;
  const match = html.match(regex);
  if (!match) return null;

  const tracksDict = {};
  const meta = { name: null };
  try {
    const data = JSON.parse(match[1]);
    extractTracksAndMeta(data, tracksDict, meta);
  } catch (e) {
    console.error("플레이리스트 JSON 파싱 에러:", e);
    return null;
  }

  return { name: meta.name || "(이름 없음)", tracks: tracksDict };
}

// ==========================================
// 5. 유저 프로필 페이지 스크래핑 (이름 + 플레이리스트 목록)
// ==========================================
function fetchUserProfileViaScrape(userId) {
  const profileUrl = ["https://", "open", ".spotify.com/user/", userId].join("");

  const options = {
    method: "get",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(profileUrl, options);
  if (response.getResponseCode() !== 200) {
    return null;
  }

  const html = response.getContentText();

  // --- 표시 이름(닉네임) 추출 ---
  let displayName = null;
  let m = html.match(/<title>(.*?)\s+on Spotify<\/title>/i);
  if (m) displayName = m[1].trim();
  if (!displayName) {
    m = html.match(/<meta property="og:title" content="([^"]*)"/i);
    if (m) displayName = m[1].trim();
  }

  // --- 플레이리스트 ID 목록 추출 ---
  // 1차: 페이지에 JSON 상태 블록이 있으면 그걸 우선 신뢰
  let playlistIds = [];
  const jsonScriptRegex = /<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gs;
  let scriptMatch;
  const foundFromJson = {};
  while ((scriptMatch = jsonScriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(scriptMatch[1]);
      extractPlaylistRefs(data, foundFromJson);
    } catch (e) {
      // 이 스크립트 블록은 JSON이 아니거나 파싱 실패 → 무시하고 다음 블록 시도
    }
  }
  playlistIds = Object.keys(foundFromJson);

  // 2차 폴백: JSON 블록이 없거나 비어있으면 href 패턴으로 직접 추출
  if (playlistIds.length === 0) {
    const hrefRegex = /\/playlist\/([a-zA-Z0-9]+)/g;
    const seen = {};
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(html)) !== null) {
      const id = hrefMatch[1];
      if (!seen[id]) {
        seen[id] = true;
        playlistIds.push(id);
      }
    }
  }

  return { displayName: displayName, playlistIds: playlistIds };
}

// ==========================================
// 6. 디스코드 임베드 빌더들
// ==========================================
function buildTrackChangeEmbed(playlistId, playlistName, added, removed) {
  const playlistUrl = ["https://", "open", ".spotify.com/embed/playlist/", playlistId].join("");
  let lines = [];

  Object.values(added).forEach(t => {
    lines.push(`**[${playlistName}]** : [${t.name}](${t.link}) 추가`);
  });
  Object.values(removed).forEach(t => {
    lines.push(`**[${playlistName}]** : [${t.name}](${t.link}) 삭제`);
  });

  if (lines.length === 0) return null;

  let text = lines.join("\n");
  if (text.length > 4000) text = text.substring(0, 4000) + "\n... (생략됨)";

  return {
    title: "플레이리스트가 변경 되었습니다",
    url: playlistUrl,
    description: text,
    color: 1947988, // 스포티파이 초록
    timestamp: new Date().toISOString()
  };
}

function buildPlaylistAddedEmbed(playlistId, playlistName) {
  const playlistUrl = ["https://", "open", ".spotify.com/playlist/", playlistId].join("");
  return {
    title: "📂 새 플레이리스트가 추가되었습니다",
    url: playlistUrl,
    description: `**[${playlistName}]** 플레이리스트가 프로필에 새로 추가되었습니다.`,
    color: 3066993, // 초록
    timestamp: new Date().toISOString()
  };
}

function buildPlaylistRemovedEmbed(playlistName) {
  return {
    title: "🗑️ 플레이리스트가 사라졌습니다",
    description: `**[${playlistName}]** 플레이리스트가 삭제되었거나, 비공개/프로필에서 제외되었습니다.`,
    color: 15158332, // 빨강
    timestamp: new Date().toISOString()
  };
}

function buildPlaylistRenamedEmbed(playlistId, oldName, newName) {
  const playlistUrl = ["https://", "open", ".spotify.com/playlist/", playlistId].join("");
  return {
    title: "✏️ 플레이리스트 이름이 변경되었습니다",
    url: playlistUrl,
    description: `**${oldName}** → **${newName}**`,
    color: 15105570, // 주황
    timestamp: new Date().toISOString()
  };
}

function buildUserNameChangedEmbed(userId, oldName, newName) {
  const profileUrl = ["https://", "open", ".spotify.com/user/", userId].join("");
  return {
    title: "👤 유저 이름이 변경되었습니다",
    url: profileUrl,
    description: `**${oldName}** → **${newName}**`,
    color: 10181046, // 보라
    timestamp: new Date().toISOString()
  };
}

// 임베드 배열을 한번에(혹은 10개 단위로 나눠서) 전송
function sendDiscordEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return;
  // 디스코드는 메시지 1개당 임베드 최대 10개까지 허용
  for (let i = 0; i < embeds.length; i += 10) {
    const chunk = embeds.slice(i, i + 10);
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ embeds: chunk }),
      muteHttpExceptions: true
    };
    UrlFetchApp.fetch(DISCORD_WEBHOOK_URL, options);
  }
}

// ==========================================
// 7. 메인 감시 함수 (유저 단위)
// ==========================================
function monitorUser() {
  try {
    const fullState = loadState(); // { displayName, playlists: { [id]: { name, tracks, pendingVerify } } }
    let isStateChanged = false;
    const embedsToSend = [];

    const profile = fetchUserProfileViaScrape(TARGET_USER_ID);
    if (!profile) {
      console.warn("유저 프로필 접근 차단됨 또는 오류 발생. 이번 턴 스킵.");
      return;
    }

    // --- 1) 유저 이름 변경 감지 ---
    if (profile.displayName) {
      if (!fullState.displayName) {
        console.log(`🔓 유저 이름 첫 기록: ${profile.displayName}`);
        fullState.displayName = profile.displayName;
        isStateChanged = true;
      } else if (fullState.displayName !== profile.displayName) {
        console.log(`유저 이름 변경 감지: ${fullState.displayName} → ${profile.displayName}`);
        embedsToSend.push(buildUserNameChangedEmbed(TARGET_USER_ID, fullState.displayName, profile.displayName));
        fullState.displayName = profile.displayName;
        isStateChanged = true;
      }
    }

    const currentPlaylistIds = profile.playlistIds;
    const previousPlaylistIds = Object.keys(fullState.playlists);
    const isFirstRun = previousPlaylistIds.length === 0;

    const currentSet = {};
    currentPlaylistIds.forEach(id => { currentSet[id] = true; });
    const previousSet = {};
    previousPlaylistIds.forEach(id => { previousSet[id] = true; });

    // --- 2) 목록에서 사라진 플레이리스트 감지 (삭제/비공개 전환 등) ---
    previousPlaylistIds.forEach(id => {
      if (!currentSet[id]) {
        const removedName = (fullState.playlists[id] && fullState.playlists[id].name) || "(알 수 없는 플레이리스트)";
        console.log(`플레이리스트 사라짐 감지: ${removedName}`);
        embedsToSend.push(buildPlaylistRemovedEmbed(removedName));
        delete fullState.playlists[id];
        isStateChanged = true;
      }
    });

    // --- 3) 현재 플레이리스트들 순회: 신규/트랙 변경/이름 변경 감지 ---
    for (const playlistId of currentPlaylistIds) {
      const isNewPlaylist = !previousSet[playlistId];

      const playlistData = fetchPlaylistViaEmbed(playlistId);
      if (!playlistData) {
        console.warn(`[${playlistId}] 접근 차단됨 또는 오류 발생. 이번 턴 스킵.`);
        Utilities.sleep(500);
        continue;
      }

      if (isNewPlaylist) {
        if (!isFirstRun) {
          console.log(`📂 새 플레이리스트 감지: ${playlistData.name}`);
          embedsToSend.push(buildPlaylistAddedEmbed(playlistId, playlistData.name));
        } else {
          console.log(`🔓 첫 기록 - 베이스라인 저장: ${playlistData.name}`);
        }
        fullState.playlists[playlistId] = {
          name: playlistData.name,
          tracks: playlistData.tracks,
          pendingVerify: false
        };
        isStateChanged = true;
      } else {
        const state = fullState.playlists[playlistId];
        const oldTracks = state.tracks || {};
        const currentTracks = playlistData.tracks;

        // 이름(제목) 변경 감지
        if (playlistData.name && state.name && playlistData.name !== state.name) {
          console.log(`✏️ 플레이리스트 이름 변경: ${state.name} → ${playlistData.name}`);
          embedsToSend.push(buildPlaylistRenamedEmbed(playlistId, state.name, playlistData.name));
          state.name = playlistData.name;
          isStateChanged = true;
        }

        const currentTrackIds = Object.keys(currentTracks);
        const currentIdsStr = currentTrackIds.sort().join(",");
        const oldIdsStr = Object.keys(oldTracks).sort().join(",");

        if (currentIdsStr !== oldIdsStr) {
          let addedTracks = {};
          let removedTracks = {};
          for (let id in currentTracks) { if (!oldTracks[id]) addedTracks[id] = currentTracks[id]; }
          for (let id in oldTracks) { if (!currentTracks[id]) removedTracks[id] = oldTracks[id]; }

          const addedCount = Object.keys(addedTracks).length;
          const removedCount = Object.keys(removedTracks).length;

          // 대량 변동 시 1턴 대기 (서버 렉으로 인한 오탐 방지)
          if ((addedCount >= 5 || removedCount >= 5) && !state.pendingVerify) {
            console.log(`[${state.name}] 대량 변동 감지(추가 ${addedCount}, 삭제 ${removedCount}). 1턴 대기.`);
            state.pendingVerify = true;
            isStateChanged = true;
          } else {
            console.log(`[${state.name}] 트랙 변동 확정! 알림 추가.`);
            const embed = buildTrackChangeEmbed(playlistId, state.name, addedTracks, removedTracks);
            if (embed) embedsToSend.push(embed);
            state.tracks = currentTracks;
            state.pendingVerify = false;
            isStateChanged = true;
          }
        } else if (state.pendingVerify) {
          console.log(`[${state.name}] 서버 렉 회복 완료. 가짜 알림 오작동을 방어했습니다!`);
          state.pendingVerify = false;
          isStateChanged = true;
        }
      }

      Utilities.sleep(500);
    }

    if (embedsToSend.length > 0) {
      sendDiscordEmbeds(embedsToSend);
    }

    if (isStateChanged) {
      saveState(fullState);
    }

  } catch (e) {
    console.error("시스템 치명적 에러: " + e.message);
  }
}
