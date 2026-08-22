import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const breaks=[[10*60+30,10*60+45],[12*60,13*60],[15*60+30,15*60+45]];
const targets=(start,final)=>{const first=start%60===0?start+60:Math.ceil(start/60)*60,out=[];for(let t=first;t<=final;t+=60)out.push(t);return out};
const working=(start,end)=>Math.max(0,end-start-breaks.reduce((sum,[a,b])=>sum+Math.max(0,Math.min(end,b)-Math.max(start,a)),0));
const pace=(remaining,start,deadline)=>{const minutes=working(start,deadline),hourly=minutes?Math.ceil(remaining/(minutes/60)):0;return{minutes,hourly,per15:Math.ceil(hourly/4)}};
const allocate=(total,plans)=>{let remaining=total;return plans.map(plan=>{const value=Math.min(remaining,plan);remaining-=value;return value})};
const allocateSequential=(total,waves)=>{const values=Object.fromEntries(waves.map(w=>[w.id,0]));let remaining=Math.max(0,total);for(const wave of waves){const value=Math.min(remaining,wave.planned);values[wave.id]=value;remaining-=value}if(remaining>0&&waves.length)values[waves.at(-1).id]+=remaining;return values};
const reconcile=(wave,snapshots)=>{const latest=snapshots.filter(x=>x.source!=='completion').toSorted((a,b)=>a.targetMinute-b.targetMinute).at(-1),completed=latest?.completed??wave.completed;return{...wave,completed,completedAt:wave.completedAt&&completed<wave.planned?null:wave.completedAt}};
const completionCandidates=(values,waves,targetMinute,dismissals=[])=>waves.filter(w=>values[w.id]>=w.planned&&!w.completedAt&&!dismissals.some(x=>x.waveId===w.id&&x.targetMinute===targetMinute)).map(w=>w.id);
const requirement=({remaining,now,deadline,current,onePersonRate=100})=>{
  if(remaining<=0)return{status:'complete',required:0,action:'本日の作業は完了'};
  if(now>=deadline)return{status:'overdue',required:null,rate:null,action:'締切超過'};
  const effective=working(now,deadline);if(effective<=0)return{status:'overdue',required:null,rate:null,action:'締切超過'};
  const rate=Math.ceil(remaining/(effective/60)),required=Math.max(1,Math.ceil(rate/onePersonRate)),gap=required-current;
  return{status:'active',required,rate,action:gap>0?`${gap}名増員推奨`:gap<0?`${-gap}名余力あり`:'増員不要'};
};

test('9:30開始は10:00、11:00、12:00…を対象時刻にする',()=>{
  assert.deepEqual(targets(9*60+30,12*60),[10*60,11*60,12*60]);
});

test('11:08の入力は11:00対象として実入力時刻と分離する',()=>{
  const checkpoint={targetMinute:11*60,targetAt:'2026-08-20T11:00:00+09:00',inputAt:'2026-08-20T11:08:00+09:00',totalCompleted:60};
  assert.equal(checkpoint.targetMinute,660);
  assert.equal((new Date(checkpoint.inputAt)-new Date(checkpoint.targetAt))/60000,8);
});

test('最初の30分は30分として計算し、途中参加を人時へ反映する',()=>{
  const humanMinutes=(15*1)+(15*2);
  assert.equal(humanMinutes,45);
  assert.equal(humanMinutes/60,0.75);
});

test('休憩を除外した人時を使用する',()=>{
  assert.equal(working(10*60,11*60),45);
  assert.equal(working(12*60,13*60),0);
});

test('全体累計を処理順に便へ自動配分する',()=>{
  assert.deepEqual(allocate(100,[80,40,40]),[80,20,0]);
});

test('便完了で次便の有効時間と必要ペースを再計算する',()=>{
  const before=pace(37,15*60,17*60);
  const after=pace(37,14*60+30,17*60);
  assert.deepEqual(before,{minutes:105,hourly:22,per15:6});
  assert.deepEqual(after,{minutes:135,hourly:17,per15:5});
});

test('通常進捗入力には累計値だけを表示し、時刻・便は例外欄へ置く',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const normal=html.match(/<section id="progressPanel"[\s\S]*?<details id="manualProgressDetails"/u)?.[0]||'';
  assert.match(normal,/今日全体の累計完了店舗数/u);
  assert.doesNotMatch(normal,/対象時刻<select/u);
  assert.doesNotMatch(normal,/方面／便<select/u);
  assert.match(html,/<details id="manualProgressDetails"/u);
});

test('統合ロジックと全体終了予測を使用する',()=>{
  const js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  assert.match(js,/function recordGlobalCheckpoint/u);
  assert.match(js,/function opsRebuildStaffingTimeline/u);
  assert.match(js,/function opsGlobalActualRate/u);
  assert.match(js,/finishAtRate\(nowMinutes\(\),remaining,rate\)/u);
  assert.match(js,/confirmReachedWave[\s\S]*await completeWave\(candidate\.waveId\)/u);
  assert.match(js,/const opsLegacyCompleteWave=completeWave/u);
});

test('残り0店舗・現在0名は本日の作業完了、必要人数0名',()=>{
  assert.deepEqual(requirement({remaining:0,now:600,deadline:1080,current:0}),{status:'complete',required:0,action:'本日の作業は完了'});
});

test('残り0店舗・現在1名でも増員を要求しない',()=>{
  const result=requirement({remaining:0,now:600,deadline:1080,current:1});
  assert.equal(result.required,0);assert.equal(result.action,'本日の作業は完了');
});

test('締切前・必要1名・現在0名は1名増員推奨',()=>{
  const result=requirement({remaining:100,now:660,deadline:720,current:0});
  assert.equal(result.required,1);assert.equal(result.action,'1名増員推奨');
});

test('締切前・必要2名・現在1名は1名増員推奨',()=>{
  const result=requirement({remaining:200,now:660,deadline:720,current:1});
  assert.equal(result.required,2);assert.equal(result.action,'1名増員推奨');
});

test('残りあり・締切超過は必要ペースと必要人数を算出しない',()=>{
  assert.deepEqual(requirement({remaining:83,now:22*60+43,deadline:18*60,current:1}),{status:'overdue',required:null,rate:null,action:'締切超過'});
});

test('締切ちょうどは有効時間0の締切超過として扱う',()=>{
  assert.deepEqual(requirement({remaining:83,now:18*60,deadline:18*60,current:1}),{status:'overdue',required:null,rate:null,action:'締切超過'});
});

test('上部と全方面トータルが同じ共通計算を参照する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  assert.match(html,/function totalOperationalRequirement/u);
  assert.match(html,/function renderWorker[\s\S]*totalOperationalRequirement/u);
  assert.match(js,/function renderDashboard[\s\S]*totalOperationalRequirement/u);
});

test('手動補正は作業中の登録作業者数を下回らせない',()=>{
  const effectiveCount=(timelineCount,activeCount)=>Math.max(activeCount,Math.max(0,Number(timelineCount)||0));
  assert.equal(effectiveCount(0,1),1);
  assert.equal(effectiveCount(1,1),1);
  assert.equal(effectiveCount(2,1),2);
  const js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  assert.match(js,/Math\.max\(activeCount,Math\.max\(0,Number\(event\.count\)\)\)/u);
  assert.match(js,/count=Math\.max\(requested,activeCount\)/u);
  assert.match(js,/人数を減らす場合は、対象作業者の「終了」を押してください/u);
});

test('便カードの終了表示を完了・確認待ち・未完了で分ける',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/function waveFinishDisplay/u);
  assert.match(html,/completedAt\)return\{label:'完了時刻'/u);
  assert.match(html,/remaining<=0\)return\{label:'',value:'完了確認待ち'/u);
  assert.match(html,/return\{label:'終了予測',value:forecastFor/u);
  assert.doesNotMatch(html,/終了予測 完了確認待ち/u);
});

test('締切超過NEXT ACTIONは速度・ユニット数を表示しない',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const overdue=html.match(/if\(urgent&&next\.remaining>0\)[\s\S]*?;return\}/u)?.[0]||'';
  assert.match(overdue,/締切を超過しています/u);
  assert.match(overdue,/残り <b>\$\{next\.remaining\.toLocaleString\(\)\}店舗/u);
  assert.match(overdue,/残作業を確認してください/u);
  assert.doesNotMatch(overdue,/ユニット/u);
  assert.doesNotMatch(overdue,/必要なチーム速度/u);
});

test('通常NEXT ACTIONは0ユニット文言を表示せず、1以上なら表示する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/const unitText=Number\(state\.totalUnits\)>0\?/u);
  assert.doesNotMatch(html,/全体は <b>\$\{\(Number\(state\.totalUnits\)\|\|0\)\.toLocaleString\(\)\}ユニット/u);
  const unitText=total=>Number(total)>0?`全体は ${Number(total).toLocaleString()}ユニットです。`:'';
  assert.equal(unitText(0),'');
  assert.equal(unitText(1),'全体は 1ユニットです。');
});

test('1回の累計入力で1便だけ到達すると1便だけ完了候補になる',()=>{
  const waves=[{id:'a',planned:30},{id:'b',planned:40}];
  assert.deepEqual(completionCandidates({a:30,b:0},waves,660),['a']);
});

test('1回の累計入力で2便到達すると2便とも完了候補になる',()=>{
  const waves=[{id:'a',planned:30},{id:'b',planned:40}];
  assert.deepEqual(completionCandidates({a:30,b:40},waves,660),['a','b']);
});

test('1回の累計入力で3便到達すると3便すべて完了候補になる',()=>{
  const waves=[{id:'a',planned:30},{id:'b',planned:40},{id:'c',planned:20}];
  assert.deepEqual(completionCandidates({a:30,b:40,c:20},waves,660),['a','b','c']);
});

test('完了済み便と同じ対象時刻で保留した便は再確認しない',()=>{
  const waves=[{id:'a',planned:30,completedAt:'2026-08-20T10:00:00+09:00'},{id:'b',planned:40},{id:'c',planned:20}];
  assert.deepEqual(completionCandidates({a:30,b:40,c:20},waves,660,[{waveId:'b',targetMinute:660}]),['c']);
});

test('完了・保留のどちらでも次候補を表示するキューを使用する',()=>{
  const js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  assert.match(js,/opsCompletionQueue=opsReachedCompletionCandidates/u);
  assert.match(js,/confirmReachedWave[\s\S]*opsShowNextCompletionCandidate\(\)/u);
  assert.match(js,/dismissReachedWave[\s\S]*opsShowNextCompletionCandidate\(\)/u);
  assert.doesNotMatch(js,/opsOrderedWaves\(\)\.find\(w=>\(Number\(waveValues/u);
});

test('再読み込み時に最新の保存済み進捗から全完了候補を復元する',()=>{
  const js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  const waves=[{id:'a',planned:30},{id:'b',planned:40},{id:'c',planned:20}],checkpoints=[{targetMinute:600,waveValues:{a:20,b:0,c:0}},{targetMinute:660,waveValues:{a:30,b:40,c:0}}];
  const latest=checkpoints.toSorted((a,b)=>a.targetMinute-b.targetMinute).at(-1);
  assert.deepEqual(completionCandidates(latest.waveValues,waves,latest.targetMinute),['a','b']);
  assert.match(js,/function opsRestoreCompletionCandidates\(\)/u);
  assert.match(js,/progressCheckpoints[\s\S]*sort\(\(a,b\)=>Number\(a\.targetMinute\)-Number\(b\.targetMinute\)\)\.at\(-1\)/u);
  assert.match(js,/opsCompletionQueue=opsReachedCompletionCandidates\(latest\.waveValues,Number\(latest\.targetMinute\)\)/u);
  assert.match(js,/render=function\(\)\{opsLegacyRenderWithCompletionRestore\(\);opsRestoreCompletionCandidates\(\)\}/u);
});

test('固定進捗ボタンは現在作業中と進捗入力欄の表示中に自動で隠れる',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const setup=html.match(/function setupMobileProgressNav\(\)[\s\S]*?quickWave\.addEventListener/u)?.[0]||'';
  assert.match(setup,/getElementById\('activeWorkersPanel'\)/u);
  assert.match(setup,/\[panel,activeWorkers\]\.filter\(Boolean\)/u);
  assert.match(setup,/visibleBlockers\.values\(\)/u);
  assert.match(html,/\.mobile-progress-nav\.is-hidden\{opacity:0;pointer-events:none/u);
});

test('スマホの進捗入力状況は2列で右端切れなく表示する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/\.snapshot-status\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:7px;overflow:visible\}/u);
  assert.match(html,/\.snapshot-chip\{min-width:0;white-space:normal;text-align:center;overflow-wrap:anywhere\}/u);
});

test('計画32・最終有効実績31は未完了・残り1へ戻る',()=>{
  const result=reconcile({id:'chukyo',planned:32,completed:32,completedAt:'2026-08-20T15:02:00+09:00'},[{targetMinute:600,completed:31}]);
  assert.equal(result.completed,31);assert.equal(result.completedAt,null);assert.equal(result.planned-result.completed,1);
});

test('計画32・最終有効実績32は完了状態なら残り0を維持する',()=>{
  const completedAt='2026-08-20T15:02:00+09:00',result=reconcile({id:'chukyo',planned:32,completed:32,completedAt},[{targetMinute:600,completed:32}]);
  assert.equal(result.completed,32);assert.equal(result.completedAt,completedAt);assert.equal(result.planned-result.completed,0);
});

test('10:00を31へ修正しても11:00最終累計35なら完了を維持する',()=>{
  const completedAt='2026-08-20T15:02:00+09:00',result=reconcile({id:'chukyo',planned:32,completed:32,completedAt},[{targetMinute:600,completed:31},{targetMinute:660,completed:35}]);
  assert.equal(result.completed,35);assert.equal(result.completedAt,completedAt);assert.equal(Math.max(0,result.planned-result.completed),0);
});

test('完了済み32を31へ修正後、32へ再修正すると完了確認候補へ戻る',()=>{
  const completion={targetMinute:900,completed:32,source:'completion'},reopened=reconcile({id:'chukyo',planned:32,completed:32,completedAt:'2026-08-20T15:02:00+09:00'},[{targetMinute:600,completed:31},completion]);
  assert.equal(reopened.completedAt,null);
  const reached=reconcile(reopened,[{targetMinute:600,completed:32},completion]);
  assert.equal(reached.completedAt,null);
  assert.deepEqual(completionCandidates({chukyo:32},[reached],600),['chukyo']);
});

test('未完了へ戻ると実績を後続便へ固定せず処理順で再配分する',()=>{
  const waves=[{id:'chukyo',planned:32},{id:'kansai',planned:40},{id:'kyushu2',planned:20}];
  assert.deepEqual(allocateSequential(31,waves),{chukyo:31,kansai:0,kyushu2:0});
  assert.deepEqual(allocateSequential(75,waves),{chukyo:32,kansai:40,kyushu2:3});
  const result=requirement({remaining:1+40+20,now:14*60,deadline:18*60,current:1});
  assert.equal(result.status,'active');assert.equal(result.rate,17);assert.equal(result.required,1);assert.equal(result.action,'増員不要');
});

test('再読み込み後も最新実績31なら未完了、35なら完了を維持する',()=>{
  const saved=JSON.parse(JSON.stringify({wave:{id:'chukyo',planned:32,completed:32,completedAt:'2026-08-20T15:02:00+09:00'},snapshots:[{targetMinute:600,completed:31}]}));
  const reopened=reconcile(saved.wave,saved.snapshots);assert.equal(reopened.completed,31);assert.equal(reopened.completedAt,null);
  saved.snapshots.push({targetMinute:660,completed:35});const maintained=reconcile(saved.wave,saved.snapshots);assert.equal(maintained.completed,35);assert.equal(maintained.completedAt,saved.wave.completedAt);
});

test('最新有効実績による完了再判定を読込・便別修正・全体再配分で共通適用する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const js=readFileSync(new URL('./ship-pace-ops.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/completedAt\?Math\.max\(planned,completed\):completed/u);
  assert.match(js,/function opsReconcileCompletionState\(\)/u);
  assert.match(js,/x\.source!==['"]completion['"]/u);
  assert.match(js,/completed<Math\.max\(0,Number\(w\.planned\)\|\|0\)\)w\.completedAt=null/u);
  assert.match(js,/safeCompleted=opsProgressValue\(completed\)/u);
  assert.doesNotMatch(js,/completedFloor=ordered\.filter\(w=>w\.completedAt\)/u);
  assert.match(js,/opsReconcileCompletionState\(\);return\{checkpoint,totalCompleted,targetAt,inputAt\}/u);
  assert.match(js,/opsReconcileCompletionState\(\);\s*return\{checkpoint,waveValues,totalCompleted:total/u);
});

test('使い方ガイドは手動で開閉し、背景操作を止める',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/>？ 使い方<\/button>/u);
  assert.match(html,/id="usageGuide"[\s\S]*?aria-modal="true"[\s\S]*?hidden/u);
  assert.match(html,/function openUsageGuide\(\)[\s\S]*?usageGuide\.hidden=false[\s\S]*?usage-guide-open/u);
  assert.match(html,/function closeUsageGuide\(\)[\s\S]*?usageGuide\.hidden=true[\s\S]*?usage-guide-open/u);
  assert.match(html,/if\(event\.key==='Escape'&&!usageGuide\.hidden\)closeUsageGuide\(\)/u);
  assert.match(html,/body\.usage-guide-open\{overflow:hidden;touch-action:none\}/u);
});

test('使い方ガイドは正式な5ステップと例外修正の注意を表示する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const guide=html.match(/<div id="usageGuide"[\s\S]*?<div id="authScreen"/u)?.[0]||'';
  for(const text of ['作業開始','人が入る／抜ける','進捗を入力','上部を見る','便が終わる'])assert.match(guide,new RegExp(text,'u'));
  assert.match(guide,/9:30開始 → 10:00 ／ 10:00開始 → 11:00/u);
  assert.match(guide,/迷ったら、まず上部の「現在の進捗」を確認/u);
  assert.match(guide,/① 現在の進捗　② 必要人数　③ 完了見込み/u);
  assert.match(guide,/通常の進捗入力では使用しません/u);
  assert.doesNotMatch(guide,/https?:\/\//u);
});

test('使い方ガイドはiPhone幅で横にはみ出さないレイアウトを使用する',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/\.usage-guide-card\{width:min\(540px,100%\)/u);
  assert.match(html,/\.usage-step\{display:grid;grid-template-columns:30px minmax\(0,1fr\)/u);
  assert.match(html,/@media\(max-width:400px\)[\s\S]*?\.usage-guide\{padding:10px\}/u);
  assert.match(html,/max-height:calc\(100dvh - 20px\)/u);
});

test('詳しい操作ガイドは8枚の画像をSHIP PACE内でページ送りできる',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/href="\.\/manual\.pdf" onclick="openManualGuide\(event\)">詳しい操作ガイドを見る<\/a>/u);
  assert.match(html,/class="usage-guide-manual-note">SHIP PACE内で開きます<\/small>/u);
  assert.match(html,/id="manualGuideView" class="manual-guide-view"[\s\S]*?← SHIP PACEに戻る[\s\S]*?<img id="manualGuideImage"[\s\S]*?src="\.\/manual-pages\/page-1\.jpg"[\s\S]*?id="manualGuidePrev"[\s\S]*?>前へ<\/button>[\s\S]*?1 \/ 8[\s\S]*?id="manualGuideNext"[\s\S]*?>次へ<\/button>/u);
  assert.doesNotMatch(html,/<iframe class="manual-guide-frame"/u);
  assert.match(html,/\.manual-guide-view\{position:fixed;inset:0;z-index:100;display:grid;grid-template-rows:auto minmax\(0,1fr\) auto;width:100%;max-width:100%;height:100dvh/u);
  assert.match(html,/const MANUAL_PAGE_COUNT=8;/u);
  assert.match(html,/function changeManualPage\(delta\)/u);
  assert.match(html,/manualGuidePage\.addEventListener\('touchend'/u);
  assert.match(html,/function openManualGuide\(event\)\{event\.preventDefault\(\);manualGuideScrollY=window\.scrollY;manualPageNumber=1;renderManualPage\(\);usageGuide\.hidden=true;manualGuideView\.hidden=false;/u);
  assert.match(html,/function closeManualGuide\(\)\{manualGuideView\.hidden=true;document\.body\.classList\.remove\('usage-guide-open'\);window\.scrollTo\(0,manualGuideScrollY\);/u);
  assert.match(html,/<span class="usage-guide-title-line">SHIP PACE<\/span><span class="usage-guide-title-line">これだけ覚えればOK<\/span>/u);
  const pdf=readFileSync(new URL('./manual.pdf',import.meta.url));
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  const pageObjects=pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)\b/g)||[];
  assert.equal(pageObjects.length,8);
  for(let page=1;page<=8;page+=1){
    const image=readFileSync(new URL(`./manual-pages/page-${page}.jpg`,import.meta.url));
    assert.deepEqual([...image.subarray(0,3)],[0xff,0xd8,0xff]);
  }
});
