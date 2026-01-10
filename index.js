// @ts-nocheck
import { characters, eventSource, event_types, saveSettingsDebounced, this_chid, chat } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { selected_group } from "../../../group-chats.js";

const MODULE_NAME = 'Achievement-Tracker';

// 정규식
const ASSET_PATTERNS = [
    /\{\{img::(.*?)\}\}/gi,
    /<img\s+[^>]*src=["']([^"']+)["']/gi
];
const ACHIEVEMENT_RULE_REGEX = /achievement\s*=\s*(["'])([\s\S]*?)\1/gi;
const GLOBAL_COMPLETE_REGEX = /asset_complete\s*=\s*(["'])([\s\S]*?)\1/i;

// UI 요소 ID
const ACH_LIST_ID = '#achievement_list_container';
const ASSET_LIST_ID = '#asset_list_container';
const RESET_BTN_ID = '#tracker_reset_btn';
const TOGGLE_ENABLE_ID = '#tracker_toggle_enable';
const TOGGLE_TOAST_ID = '#tracker_toast_enable';
const MSG_INPUT_ID = '#tracker_custom_msg_input';
const MSG_REVEAL_ID = '#tracker_msg_reveal';     
const MSG_STATUS_ID = '#tracker_msg_status';

const SCAN_INTERVAL = 2000;
let scanCheckpoint = 0;

function initializeSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].characterData) extension_settings[MODULE_NAME].characterData = {};
}

function getCurrentCharacter() {
    if (selected_group) return null; 
    return characters[this_chid];
}

function getCharData(charId) {
    if (!extension_settings[MODULE_NAME].characterData[charId]) {
        extension_settings[MODULE_NAME].characterData[charId] = {
            enabled: true,
            toastEnabled: true,
            unlocked_assets: [], 
            cheated_assets: [],  
            achieved_ids: [],    
            global_completed: false,
            customMessage: "" 
        };
    }
    if (!extension_settings[MODULE_NAME].characterData[charId].cheated_assets) {
        extension_settings[MODULE_NAME].characterData[charId].cheated_assets = [];
    }
    return extension_settings[MODULE_NAME].characterData[charId];
}

function getSearchTargets(character) {
    if (!character) return [];
    const targets = [
        character.data?.character_note,       
        character.data?.depth_prompt_prompt,  
        character.data?.extensions?.depth_prompt?.prompt,
        character.description, 
        character.first_mes,
        character.scenario,    
        character.mes_example, 
        character.personality, 
        character.creator_notes,
        character.creatorcomment,
        character.data?.scenario,
        character.data?.mes_example,
        character.data?.description
    ];

    const context = getContext();
    if (context && context.worldInfo) {
        context.worldInfo.forEach(entry => {
            if (entry.content) targets.push(entry.content);
        });
    }
    return targets.filter(t => t && typeof t === 'string');
}

function parseAchievementRules(character) {
    const targets = getSearchTargets(character);
    const rules = [];
    let ruleIndex = 0;

    targets.forEach(text => {
        const matches = [...text.matchAll(ACHIEVEMENT_RULE_REGEX)];
        matches.forEach(match => {
            const content = match[2];
            const ruleObj = {
                id: `achv_${ruleIndex++}`,
                keyword: "",
                title: "히든 업적",
                msg: "달성했습니다!",
                targetCount: 0 
            };
            const parts = content.split('|');
            parts.forEach(part => {
                const pair = part.split(':');
                if (pair.length >= 2) {
                    const key = pair[0].trim().toLowerCase();
                    const val = pair.slice(1).join(':').trim();
                    if (key && val) {
                        if (key === 'keyword') ruleObj.keyword = val;
                        if (key === 'title') ruleObj.title = val;
                        if (key === 'msg') ruleObj.msg = val;
                        if (key === 'count') ruleObj.targetCount = parseInt(val, 10) || 0; 
                    }
                }
            });
            if (ruleObj.keyword) {
                rules.push(ruleObj);
            }
        });
    });
    return rules;
}

function getGlobalCompletionMessage(character) {
    const targets = getSearchTargets(character);
    for (const text of targets) {
        const match = text.match(GLOBAL_COMPLETE_REGEX);
        if (match && match[2]) return match[2]; 
    }
    return null;
}

async function fetchAllAssets(characterName) {
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(characterName)}`);
        if (!result.ok) return [];
        const json = await result.json();
        return json.map(item => item.path.split('/').pop().split('?')[0]);
    } catch (e) {
        console.error('애셋 로드 실패:', e);
        return [];
    }
}

function extractFileNames(text) {
    if (!text || typeof text !== 'string') return [];
    const found = new Set();
    ASSET_PATTERNS.forEach(regex => {
        const matches = [...text.matchAll(new RegExp(regex))];
        for (const m of matches) if (m[1]) found.add(m[1].trim());
    });
    return Array.from(found);
}

// --- 스캔 로직 ---
async function scanChatHistory() {
    const char = getCurrentCharacter();
    if (!char || !chat) return;
    
    const charId = String(this_chid);
    const data = getCharData(charId);
    if (!data.enabled) return;

    // 검문소: 서버 파일 확인
    const charName = char.avatar.replace(/\.[^/.]+$/, '');
    const validAssets = await fetchAllAssets(charName);
    
    if (!validAssets) return;

    let isUpdated = false;
    let newlyFoundFiles = [];

    let startIndex = Math.max(scanCheckpoint, chat.length - 15);
    if (startIndex < 0) startIndex = 0;

    for (let i = startIndex; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;

        const content = msg.mes || msg.message;
        const foundStrings = extractFileNames(content);
        
        foundStrings.forEach(rawString => {
            const cleanName = rawString.split('/').pop().split('?')[0];

            if (validAssets.includes(cleanName)) {
                if (!data.unlocked_assets.includes(cleanName)) {
                    data.unlocked_assets.push(cleanName);
                    isUpdated = true;
                    newlyFoundFiles.push(cleanName);
                }
            }
        });
    }

    if (isUpdated) {
        saveSettingsDebounced();
        
        if (data.toastEnabled && newlyFoundFiles.length > 0) {
            if (newlyFoundFiles.length <= 2) {
                newlyFoundFiles.forEach(fileName => {
                    toastr.info(`${fileName} 발견!`, '', { timeOut: 3000, extendedTimeOut: 1500 });
                });
            } else {
                toastr.info(`${newlyFoundFiles.length}개의 새 애셋을 발견했습니다!`, '', { timeOut: 3000, extendedTimeOut: 1500 });
            }
        }

        if (document.querySelector(ACH_LIST_ID)) {
             await updateUI(); 
        }
    }
}

// --- UI 업데이트 ---
async function updateUI() {
    const achContainer = $(ACH_LIST_ID);
    const assetContainer = $(ASSET_LIST_ID);

    if (achContainer.length === 0 || assetContainer.length === 0) return;

    const char = getCurrentCharacter();
    if (!char) {
        achContainer.html('<div style="text-align:center; padding:10px; color:gray;">캐릭터 없음</div>');
        assetContainer.html('<div style="text-align:center; padding:20px; color:gray;">캐릭터를 선택해주세요.</div>');
        return;
    }

    const charName = char.avatar.replace(/\.[^/.]+$/, '');
    const allFiles = await fetchAllAssets(charName);
    allFiles.sort((a, b) => a.localeCompare(b));

    const rules = parseAchievementRules(char);
    const hiddenMsg = getGlobalCompletionMessage(char);
    
    const charId = String(this_chid);
    const data = getCharData(charId);
    
    $(TOGGLE_ENABLE_ID).prop('checked', data.enabled);
    $(TOGGLE_TOAST_ID).prop('checked', data.toastEnabled);

    const manualMsg = data.customMessage;
    const isRevealed = $(MSG_REVEAL_ID).is(':checked');
    const msgStatus = $(MSG_STATUS_ID);
    const msgInput = $(MSG_INPUT_ID);

    if (hiddenMsg && !manualMsg) {
        msgStatus.text('🔒 카드에서 히든 메시지가 감지됨').show();
    } else if (manualMsg) {
        msgStatus.text('✏️ 직접 입력한 메시지 사용 중').show();
    } else {
        msgStatus.hide();
    }

    if (isRevealed) {
        msgInput.show();
        if (!manualMsg && hiddenMsg) {
            msgInput.val(hiddenMsg);
        } else {
            msgInput.val(manualMsg || "");
        }
    } else {
        msgInput.hide();
    }

    if (allFiles.length > 0 && data.unlocked_assets.length >= allFiles.length) {
        if (!data.global_completed) {
            data.global_completed = true;
            saveSettingsDebounced();
            const msgToShow = manualMsg || hiddenMsg || "모든 애셋을 수집했습니다! (100% 달성)";
            toastr.success(msgToShow, '🎉 100% 달성 축하합니다!', { timeOut: 10000, extendedTimeOut: 5000 });
        }
    }

    achContainer.empty();
    if (rules.length === 0) {
        achContainer.html('<div style="text-align:center; padding:10px; color:gray; font-size:0.8em;">설정된 업적이 없습니다.<br>(Character\'s Note 등 확인 필요)</div>');
    } else {
        for (const rule of rules) {
            const targetFiles = allFiles.filter(file => file.includes(rule.keyword));
            
            let collectedCount = 0;
            let hasCheatedAsset = false;

            targetFiles.forEach(tf => {
                if (data.unlocked_assets.includes(tf)) {
                    collectedCount++;
                    if (data.cheated_assets.includes(tf)) {
                        hasCheatedAsset = true;
                    }
                }
            });

            const total = targetFiles.length; 
            let requiredCount = total;

            if (rule.targetCount > 0) {
                requiredCount = rule.targetCount;
                if (requiredCount > total) requiredCount = total;
            }

            if (total === 0) continue; 

            const isCompleted = (collectedCount >= requiredCount);
            
            let percent = 0;
            if (requiredCount > 0) {
                percent = Math.round((Math.min(collectedCount, requiredCount) / requiredCount) * 100);
            }

            if (isCompleted && !data.achieved_ids.includes(rule.id)) {
                data.achieved_ids.push(rule.id); 
                saveSettingsDebounced();
                if (data.toastEnabled) {
                    toastr.success(rule.msg, `🏆 업적 달성: ${rule.title}`, { timeOut: 10000, extendedTimeOut: 5000 });
                }
            }

            const statusClass = isCompleted ? 'unlocked' : 'locked';
            let icon = '🔒';
            if (isCompleted) {
                icon = hasCheatedAsset ? '🥈' : '🏆';
            }
            
            const titleText = isCompleted ? `${rule.title} (달성!)` : rule.title;
            const clickClass = data.enabled ? 'clickable' : '';
            const tooltip = data.enabled ? (isCompleted ? '달성 취소' : '치트 해금') : '';

            // [수정됨] 키워드 대신 rule.msg(메시지 내용)를 표시
            const progressText = `${percent}% (${collectedCount}/${requiredCount}) - ${rule.msg}`;

            const itemHtml = `
                <div class="achievement-item ${statusClass} ${clickClass}" 
                     data-type="achievement"
                     data-rule-id="${rule.id}" 
                     data-keyword="${rule.keyword}"
                     data-count="${rule.targetCount}" 
                     title="${tooltip}">
                    <div class="achievement-icon">${icon}</div>
                    <div class="achievement-info">
                        <div class="achievement-title">${titleText}</div>
                        <div class="achievement-desc">${progressText}</div>
                    </div>
                </div>
            `;
            achContainer.append(itemHtml);
        }
    }

    assetContainer.empty();
    if (allFiles.length === 0) {
        assetContainer.html('<div style="padding:10px; opacity:0.7;">애셋 파일이 없습니다.</div>');
    } else {
        allFiles.forEach(file => {
            const isUnlocked = data.unlocked_assets.includes(file);
            const isCheated = data.cheated_assets.includes(file);
            let icon = '🔒';
            if (isUnlocked) icon = isCheated ? '☑️' : '✅'; 
            
            const statusClass = isUnlocked ? 'unlocked' : 'locked';
            const clickClass = data.enabled ? 'clickable' : '';
            const titleText = data.enabled ? (isUnlocked ? '클릭하여 취소' : '클릭하여 치트') : '';

            const itemHtml = `
                <div class="asset-item ${statusClass} ${clickClass}" 
                     data-type="asset"
                     data-filename="${file}"
                     title="${titleText}">
                    <div class="asset-icon">${icon}</div>
                    <div class="asset-name">${file}</div>
                </div>
            `;
            assetContainer.append(itemHtml);
        });
        const totalPercent = Math.round((data.unlocked_assets.length / allFiles.length) * 100);
        assetContainer.append(`<div style="text-align:center; margin-top:10px; font-size:0.9em; color:gray;">전체 진행도: ${totalPercent}% (${data.unlocked_assets.length}/${allFiles.length})</div>`);
    }
}

// --- 핸들러 ---
async function handleClick(e) {
    const target = $(e.currentTarget);
    if (!target.hasClass('clickable')) return;

    const type = target.data('type');
    const charId = String(this_chid);
    const data = getCharData(charId);
    
    if (type === 'asset') {
        const fileName = target.data('filename');
        const isUnlocked = target.hasClass('unlocked');
        if (!isUnlocked) {
            if (!confirm(`😈 치트 모드\n\n[${fileName}]\n강제 해금하시겠습니까?`)) return;
            if (!data.unlocked_assets.includes(fileName)) data.unlocked_assets.push(fileName);
            if (!data.cheated_assets.includes(fileName)) data.cheated_assets.push(fileName);
            toastr.success(`${fileName} 해금 완료!`);
        } else {
            if (!confirm(`⚠️ 수집 취소\n\n[${fileName}]\n기록을 삭제하시겠습니까?`)) return;
            data.unlocked_assets = data.unlocked_assets.filter(f => f !== fileName);
            data.cheated_assets = data.cheated_assets.filter(f => f !== fileName);
            data.global_completed = false; 
            toastr.info('수집이 취소되었습니다.');
        }
    } 
    else if (type === 'achievement') {
        const keyword = target.data('keyword');
        const ruleId = target.data('rule-id');
        const targetCount = target.data('count'); 
        const isUnlocked = target.hasClass('unlocked');
        
        const char = getCurrentCharacter();
        const charName = char.avatar.replace(/\.[^/.]+$/, '');
        const allFiles = await fetchAllAssets(charName);
        
        let targetFiles = allFiles.filter(file => file.includes(keyword));
        if (targetFiles.length === 0) return;

        if (targetCount > 0 && targetFiles.length > targetCount) {
             targetFiles = targetFiles.slice(0, targetCount);
        }

        if (!isUnlocked) {
            if (!confirm(`😈 업적 치트\n\n'${keyword}' 관련 파일 ${targetFiles.length}개를 강제 해금하여 업적을 달성하시겠습니까?\n(은색 트로피 🥈로 표시됩니다)`)) return;
            targetFiles.forEach(f => {
                if (!data.unlocked_assets.includes(f)) data.unlocked_assets.push(f);
                if (!data.cheated_assets.includes(f)) data.cheated_assets.push(f);
            });
            toastr.success('업적 관련 파일이 해금되었습니다.');
        } else {
            if (!confirm(`⚠️ 업적 취소\n\n이 업적의 수집 기록(관련 파일 ${targetFiles.length}개)을 삭제하시겠습니까?`)) return;
            data.unlocked_assets = data.unlocked_assets.filter(f => !targetFiles.includes(f));
            data.cheated_assets = data.cheated_assets.filter(f => !targetFiles.includes(f));
            data.achieved_ids = data.achieved_ids.filter(id => id !== ruleId);
            data.global_completed = false;
            toastr.info('업적 기록이 초기화되었습니다.');
        }
    }
    saveSettingsDebounced();
    await updateUI();
}

function handleMsgRevealChange() { updateUI(); }
function handleCustomMsgChange() {
    const charId = String(this_chid);
    const data = getCharData(charId);
    data.customMessage = $(MSG_INPUT_ID).val();
    saveSettingsDebounced();
}
function handleReset() {
    if (!confirm('초기화하시겠습니까?')) return;
    const data = getCharData(String(this_chid));
    if (chat && Array.isArray(chat)) {
        scanCheckpoint = chat.length; 
    }
    data.unlocked_assets = [];
    data.cheated_assets = [];
    data.achieved_ids = [];
    data.global_completed = false;
    saveSettingsDebounced();
    updateUI();
    toastr.info('초기화 완료 (과거 내역 인식 중지)');
}
function handleToggleEnable() {
    const data = getCharData(String(this_chid));
    data.enabled = $(TOGGLE_ENABLE_ID).is(':checked');
    saveSettingsDebounced();
    if(data.enabled) scanChatHistory();
}
function handleToggleToast() {
    const data = getCharData(String(this_chid));
    data.toastEnabled = $(TOGGLE_TOAST_ID).is(':checked');
    saveSettingsDebounced();
}

function initializeExtension() {
    initializeSettings();
    $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`)
        .then(html => {
            $('#extensions_settings').append(html);
            $(document).on('click', RESET_BTN_ID, handleReset);
            $(document).on('change', TOGGLE_ENABLE_ID, handleToggleEnable);
            $(document).on('change', TOGGLE_TOAST_ID, handleToggleToast);
            $(document).on('click', '.achievement-item, .asset-item', handleClick);
            $(document).on('change', MSG_REVEAL_ID, handleMsgRevealChange);
            $(document).on('input', MSG_INPUT_ID, handleCustomMsgChange);
        });

    setInterval(() => {
        scanChatHistory();
    }, SCAN_INTERVAL);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        scanCheckpoint = 0;
        updateUI();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        scanChatHistory();
    });

    console.log(`[${MODULE_NAME}] 로드 완료 (키워드 대신 메시지 표시)`);
}

$(document).ready(initializeExtension);