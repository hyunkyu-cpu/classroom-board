import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signOut, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, collection, query, onSnapshot, updateDoc, addDoc, serverTimestamp, deleteDoc, getDocs, where, writeBatch } from 'firebase/firestore';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';

// Tailwind CSS is assumed to be included in the HTML file.
// <script src="https://cdn.tailwindcss.com"></script>

// Firebase configuration from environment variables
const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID
};

const appId = process.env.REACT_APP_FIREBASE_PROJECT_ID || 'growth-app-default';


// Create Firebase Context
const FirebaseContext = createContext(null);

// Hardcoded account information for demonstration
const studentAccounts = {
    "김대수": "1024", "김주한": "0623", "김차영": "0630", "김태린": "0609",
    "김혜지": "1029", "안준희": "1207", "인선우": "1010", "정군": "0420",
    "정유이": "0609", "최지음": "0820", "박초": "1022"
};
const teacherAccounts = { "교사": "5555" };

// Helper object to manage Firebase paths
const firebasePaths = {
    userProfile: (userId) => `artifacts/${appId}/users/${userId}/privateData/profile`,
    publicStudentProfile: (userId) => `artifacts/${appId}/public/data/teacherViewableStudentProfiles/${userId}`,
    missions: () => `artifacts/${appId}/public/data/missions`,
    missionDoc: (missionId) => `artifacts/${appId}/public/data/missions/${missionId}`,
    customRoutines: (userId) => `artifacts/${appId}/users/${userId}/customRoutines`,
    customRoutineDoc: (userId, routineId) => `artifacts/${appId}/users/${userId}/customRoutines/${routineId}`,
    growthJournal: (userId) => `artifacts/${appId}/users/${userId}/growthJournal`,
    growthJournalDoc: (userId, entryId) => `artifacts/${appId}/users/${userId}/growthJournal/${entryId}`
};


// Firebase Provider Component
const FirebaseProvider = ({ children }) => {
    const [auth, setAuth] = useState(null);
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);
    const [userRole, setUserRole] = useState(null);
    const [loading, setLoading] = useState(true);
    const [isAuthInitialized, setIsAuthInitialized] = useState(false);

    useEffect(() => {
        // Initialize Firebase only if the config is available
        if (firebaseConfig && Object.keys(firebaseConfig).length > 0) {
            const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
            setAuth(getAuth(app));
            setDb(getFirestore(app));
        } else {
            console.error("Firebase config is not available.");
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!auth || !db) return;

        const performInitialSignIn = async () => {
            try {
                await signInAnonymously(auth);
            } catch (error) {
                console.error("Initial sign-in failed:", error);
                setLoading(false);
                setIsAuthInitialized(true);
            }
        };

        performInitialSignIn();

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                setUserId(user.uid);
                const userProfileRef = doc(db, firebasePaths.userProfile(user.uid));
                try {
                    const userProfileSnap = await getDoc(userProfileRef);
                    setUserRole(userProfileSnap.exists() ? userProfileSnap.data().role : null);
                } catch (error) {
                    console.error("Error fetching user profile:", error);
                    setUserRole(null);
                } finally {
                    setLoading(false);
                    setIsAuthInitialized(true);
                }
            } else {
                // User is signed out
                setUserId(null);
                setUserRole(null);
                setLoading(false);
                setIsAuthInitialized(true);
            }
        });
        
        return () => unsubscribe();
    }, [auth, db]);

    const login = useCallback(async (inputID, inputPassword) => {
        if (!auth || !db || !auth.currentUser) return { success: false, error: "Firebase is not ready." };
        setLoading(true);
        try {
            let role = null;
            if (studentAccounts[inputID] === inputPassword) role = 'student';
            else if (teacherAccounts[inputID] === inputPassword) role = 'teacher';
            else throw new Error("잘못된 ID 또는 비밀번호입니다.");

            const firebaseUser = auth.currentUser;
            const userProfileRef = doc(db, firebasePaths.userProfile(firebaseUser.uid));
            const initialSkills = { "문해력": 0, "수리력": 0, "창의력": 0, "책임감": 0, "문제 해결 능력": 0, "자기 주도 학습 능력": 0 };
            const userProfileData = {
                userId: firebaseUser.uid, role, displayName: inputID,
                xp: 0, gold: 0, level: 1, skills: initialSkills
            };

            await setDoc(userProfileRef, userProfileData, { merge: true });

            if (role === 'student') {
                const publicStudentProfileRef = doc(db, firebasePaths.publicStudentProfile(firebaseUser.uid));
                await setDoc(publicStudentProfileRef, { ...userProfileData, lastUpdate: serverTimestamp(), isDeleted: false }, { merge: true });
            }
            
            setUserRole(role);
            return { success: true, role };
        } catch (error) {
            console.error("Login failed:", error);
            return { success: false, error: error.message };
        } finally {
            setLoading(false);
        }
    }, [auth, db]);

    const logout = useCallback(async () => {
        if (!auth) return;
        setLoading(true);
        try {
            await signOut(auth);
        } catch (error) {
            console.error("Logout failed:", error);
            setLoading(false);
        }
    }, [auth]);

    const value = { auth, db, userId, userRole, loading, login, logout, isAuthInitialized };
    return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
};

const useFirebase = () => useContext(FirebaseContext);

// Gemini API call helper
async function callGeminiAPIWithExponentialBackoff(apiUrl, payload) {
    let retries = 3;
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(`API call failed: ${response.status} - ${errorBody.error?.message || 'Unknown error'}`);
            }
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                return result.candidates[0].content.parts[0].text;
            } else {
                console.error("Invalid Gemini API response structure:", result);
                throw new Error("Invalid Gemini API response structure.");
            }
        } catch (error) {
            console.error(`Gemini API call attempt ${i + 1} failed:`, error);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
    return null;
}

// Gemini API call function
async function callGeminiAPI(prompt) {
    const apiKey = process.env.REACT_APP_GEMINI_API_KEY || "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
    return callGeminiAPIWithExponentialBackoff(apiUrl, payload);
}

// Gemini API structured output call function
async function callGeminiAPIStructured(prompt, schema) {
    const apiKey = process.env.REACT_APP_GEMINI_API_KEY || "";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema }
    };
    const resultText = await callGeminiAPIWithExponentialBackoff(apiUrl, payload);
    return resultText ? JSON.parse(resultText) : null;
}

// Schemas for structured API calls
const missionSchema = { type: "ARRAY", items: { type: "OBJECT", properties: { "title": { "type": "STRING" }, "type": { "type": "STRING", "enum": ["읽기", "쓰기", "수리", "문제풀이", "창작", "탐구"] }, "description": { "type": "STRING" }, "rewardXp": { "type": "NUMBER" }, "rewardGold": { "type": "NUMBER" } }, required: ["title", "type", "description", "rewardXp", "rewardGold"] } };
const questionSchema = { type: "ARRAY", items: { type: "OBJECT", properties: { "questionText": { "type": "STRING" }, "type": { "type": "STRING", "enum": ["객관식", "단답형"] }, "options": { "type": "ARRAY", "items": { "type": "STRING" }, "nullable": true }, "correctAnswer": { "type": "STRING" }, "explanation": { "type": "STRING" } }, required: ["questionText", "type", "correctAnswer", "explanation"] } };

// New Schema for Teacher's AI Analysis
const analysisSchema = {
    type: "OBJECT",
    properties: {
        "summary": { "type": "STRING", "description": "학생의 주간 학습 현황에 대한 2-3문장의 요약" },
        "strength": { "type": "STRING", "description": "학생이 가장 두각을 나타낸 역량 또는 활동" },
        "weakness": { "type": "STRING", "description": "학생에게 보완이 필요한 역량 또는 활동" },
        "alert": { "type": "STRING", "nullable": true, "description": "학습 부진이 감지될 경우 경고 메시지" },
        "recommendedMissions": {
            "type": "ARRAY",
            "nullable": true,
            "description": "학습 부진 영역을 보완하기 위한 추천 미션 2개",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "title": { "type": "STRING" },
                    "type": { "type": "STRING", "enum": ["읽기", "쓰기", "수리", "문제풀이", "창작", "탐구"] },
                    "description": { "type": "STRING" },
                    "rewardXp": { "type": "NUMBER" },
                    "rewardGold": { "type": "NUMBER" }
                },
                "required": ["title", "type", "description", "rewardXp", "rewardGold"]
            }
        }
    },
    required: ["summary", "strength", "weakness"]
};


// Function to update student profile with permission handling
const updateStudentProfile = async (db, userIdToUpdate, updates, updaterId) => {
    const studentDocRef = doc(db, firebasePaths.userProfile(userIdToUpdate));
    const publicStudentProfileRef = doc(db, firebasePaths.publicStudentProfile(userIdToUpdate));
    
    try {
        const docToReadRef = (userIdToUpdate === updaterId) ? studentDocRef : publicStudentProfileRef;
        const studentProfileSnap = await getDoc(docToReadRef);

        if (!studentProfileSnap.exists()) {
            console.error("Cannot update profile, source document for student does not exist.");
            return;
        }

        let currentData = studentProfileSnap.data();
        const newXP = (currentData.xp || 0) + (updates.xp || 0);
        const newGold = (currentData.gold || 0) + (updates.gold || 0);
        let newLevel = currentData.level || 1;
        while (newXP >= newLevel * 100) { newLevel++; }
        
        const newSkills = { ...(currentData.skills || {}) };
        if (updates.skills) { 
            for (const skill in updates.skills) { 
                newSkills[skill] = (newSkills[skill] || 0) + (updates.skills[skill] || 0); 
            } 
        }
        
        const updatedProfile = { 
            ...currentData,
            xp: newXP, 
            gold: newGold, 
            level: newLevel, 
            skills: newSkills, 
            lastUpdate: serverTimestamp()
        };

        await setDoc(publicStudentProfileRef, updatedProfile, { merge: true });

        if (userIdToUpdate === updaterId) {
            await setDoc(studentDocRef, updatedProfile, { merge: true });
        }
    } catch (error) { 
        console.error("Error updating student profile:", error); 
    }
};


// Student Dashboard Component
const StudentDashboard = () => {
    const { db, userId } = useFirebase();
    const [journalEntry, setJournalEntry] = useState('');
    const [dailyMissions, setDailyMissions] = useState([]);
    const [customRoutines, setCustomRoutines] = useState([]);
    const [newCustomRoutineTitle, setNewCustomRoutineTitle] = useState('');
    const [newCustomRoutineDays, setNewCustomRoutineDays] = useState([]);
    const [newCustomRoutineTime, setNewCustomRoutineTime] = useState('');
    const allDays = ['월', '화', '수', '목', '금', '토', '일'];
    const [characterXP, setCharacterXP] = useState(0);
    const [level, setLevel] = useState(1);
    const [gold, setGold] = useState(0);
    const [skills, setSkills] = useState({ "문해력": 0, "수리력": 0, "창의력": 0, "책임감": 0, "문제 해결 능력": 0, "자기 주도 학습 능력": 0 });
    const [displayName, setDisplayName] = useState('학생');
    const [growthJournalEntries, setGrowthJournalEntries] = useState([]);
    const [isGeneratingFeedback, setIsGeneratingFeedback] = useState(false);
    const [isGeneratingMissions, setIsGeneratingMissions] = useState(false);
    const [generatedQuestions, setGeneratedQuestions] = useState([]);
    const [studentAnswers, setStudentAnswers] = useState({});
    const [questionResults, setQuestionResults] = useState({});
    const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);

    const today = new Date();
    const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][today.getDay()];
    const todayDateString = today.toISOString().split('T')[0];

    useEffect(() => {
        if (!db || !userId) return;
        const unsubProfile = onSnapshot(doc(db, firebasePaths.userProfile(userId)), (docSnap) => { if (docSnap.exists()) { const d = docSnap.data(); setCharacterXP(d.xp||0); setLevel(d.level||1); setGold(d.gold||0); setSkills(d.skills||{}); setDisplayName(d.displayName||userId); }});
        const unsubMissions = onSnapshot(query(collection(db, firebasePaths.missions()), where("studentId", "==", userId)), (s) => { setDailyMissions(s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.generatedAt?.seconds||0)-(b.generatedAt?.seconds||0))); });
        const unsubRoutines = onSnapshot(collection(db, firebasePaths.customRoutines(userId)), (s) => { setCustomRoutines(s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.createdAt?.seconds||0)-(b.createdAt?.seconds||0))); });
        const unsubJournal = onSnapshot(query(collection(db, firebasePaths.growthJournal(userId))), (s) => { const e = s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0)); setGrowthJournalEntries(e); if(e.length>0&&e[0].questions?.length>0){setGeneratedQuestions(e[0].questions);setStudentAnswers({});setQuestionResults({});}else{setGeneratedQuestions([]);}});
        return () => { unsubProfile(); unsubMissions(); unsubRoutines(); unsubJournal(); };
    }, [db, userId]);

    useEffect(() => {
        if (!db || !userId || dailyMissions.length === 0) return;

        const processRewards = async () => {
            const missionsToReward = dailyMissions.filter(m => m.isCompleted && !m.isStudentRewarded);

            if (missionsToReward.length === 0) return;

            for (const mission of missionsToReward) {
                try {
                    const { id: missionId, rewardXp, rewardGold, type: missionType } = mission;
                    
                    let skillUpdates = { "책임감": 5 };
                    if (missionType === "읽기" || missionType === "쓰기") skillUpdates["문해력"] = 10;
                    else if (missionType === "수리" || missionType === "문제풀이") skillUpdates["수리력"] = 10;
                    
                    await updateStudentProfile(db, userId, { xp: rewardXp, gold: rewardGold, skills: skillUpdates }, userId);

                    const missionDocRef = doc(db, firebasePaths.missionDoc(missionId));
                    await updateDoc(missionDocRef, { isStudentRewarded: true });
                } catch (error) {
                    console.error(`Error processing reward for mission ${mission.id}:`, error);
                }
            }
        };

        processRewards();
    }, [dailyMissions, db, userId]);

    const handleGenerateQuestions = async (journalContent, latestJournalEntryId) => {
        setIsGeneratingQuestions(true);
        try {
            const prompt = `학생의 학습 일지 내용: "${journalContent}". 이 내용을 바탕으로, 초등학교 3학년 수준의 국어, 수학 관련 문제 3개를 만들어 줘. 반드시 정답이 명확하고 논란의 여지가 없는 문제만 출제해야 해. 문제는 객관식 또는 단답형 형식이어야 하고, 각 문제에는 명확한 정답과 친절한 해설을 포함해야 해.`;
            const questions = await callGeminiAPIStructured(prompt, questionSchema);
            if (questions?.length > 0) {
                const questionsWithIds = questions.map((q, i) => ({ ...q, id: `q-${latestJournalEntryId}-${i}` }));
                await updateDoc(doc(db, firebasePaths.growthJournalDoc(userId, latestJournalEntryId)), { questions: questionsWithIds });
                return questionsWithIds;
            }
        } catch (error) { console.error("AI 문제 생성 오류:", error); } 
        finally { setIsGeneratingQuestions(false); }
        return null;
    };

    const handleJournalSubmit = async () => {
        const entry = journalEntry.trim();
        if (!entry || !db || !userId) return;
        setIsGeneratingFeedback(true);
        let aiFeedback = "AI 피드백 생성 중...";
        try {
            const prompt = `학생의 학습 일지: "${entry}". 학생에게 긍정적인 칭찬과 격려, 그리고 구체적인 조언을 2-3문장으로 해주세요.`;
            aiFeedback = await callGeminiAPI(prompt) || "피드백 생성에 실패했습니다.";
        } catch (error) { console.error("AI 피드백 생성 오류:", error); aiFeedback = "AI 피드백 생성 중 오류가 발생했습니다."; } 
        finally { setIsGeneratingFeedback(false); }

        try {
            const newDocRef = await addDoc(collection(db, firebasePaths.growthJournal(userId)), { content: entry, timestamp: Date.now(), aiFeedback, questions: [] });
            setJournalEntry(''); 
            await updateStudentProfile(db, userId, { xp: 10, gold: 5, skills: { "문해력": 5, "창의력": 5 } }, userId);
            const genQ = await handleGenerateQuestions(entry, newDocRef.id);
            if (genQ) { setGeneratedQuestions(genQ); setStudentAnswers({}); setQuestionResults({}); }
        } catch (error) { console.error("일지 제출 오류:", error); }
    };

    const handleStudentRequestMissionCompletion = async (missionId) => {
        if (!db || !userId) return;
        try { await updateDoc(doc(db, firebasePaths.missionDoc(missionId)), { isPendingApproval: true, studentRequestedCompletionAt: serverTimestamp() }); } 
        catch (error) { console.error("미션 완료 요청 오류:", error); }
    };

    const handleGenerateDailyMissions = async () => {
        if (!db || !userId) return;
        setIsGeneratingMissions(true);
        try {
            const prompt = `너는 초등학교 3학년 담임 선생님이야. 2022 개정 교육과정을 바탕으로, 학생의 성장을 도울 수 있는 오늘의 미션 4개를 생성해줘. 국어(어휘력, 문장 만들기), 수학(세 자리 수 덧셈, 곱셈구구), 통합교과(우리 동네 관찰) 등 다양한 과목을 포함하고, 학생의 현재 레벨(${level})을 고려하여 흥미를 유발할 수 있는 창의적인 내용으로 만들어줘. 예를 들어 '내가 사는 동네의 소리를 3가지 이상 글로 표현하기', '곱셈구구 7단을 활용해서 문제 만들고 풀어보기' 와 같이 구체적으로 제시해줘. 각 미션은 'title', 'type', 'description', 'rewardXp', 'rewardGold'를 포함해야 해.`;
            const missions = await callGeminiAPIStructured(prompt, missionSchema);
            if (missions?.length > 0) {
                const collRef = collection(db, firebasePaths.missions());
                const oldMissions = await getDocs(query(collRef, where("studentId", "==", userId)));
                for (const docSnap of oldMissions.docs) { await deleteDoc(doc(collRef, docSnap.id)); }
                for (const m of missions) { await addDoc(collRef, { ...m, studentId: userId, generatedAt: serverTimestamp(), isCompleted: false, isPendingApproval: false, isStudentRewarded: false }); }
            }
        } catch (error) { console.error("일일 미션 생성 오류:", error); } 
        finally { setIsGeneratingMissions(false); }
    };

    const handleAnswerSubmission = async (qId, answer, correct, explanation) => {
        const isCorrect = answer.trim().toLowerCase() === correct.trim().toLowerCase();
        setQuestionResults(p => ({ ...p, [qId]: { isCorrect, feedback: isCorrect ? "정답!" : "오답.", explanation } }));
        if (isCorrect) { await updateStudentProfile(db, userId, { skills: { "문제 해결 능력": 15 } }, userId); }
    };

    const handleAddCustomRoutine = async () => {
        if (!newCustomRoutineTitle.trim() || newCustomRoutineDays.length === 0 || !newCustomRoutineTime.trim() || !db || !userId) return;
        try {
            await addDoc(collection(db, firebasePaths.customRoutines(userId)), { title: newCustomRoutineTitle, days: newCustomRoutineDays, time: newCustomRoutineTime, createdAt: serverTimestamp(), completedDays: {} });
            setNewCustomRoutineTitle(''); setNewCustomRoutineDays([]); setNewCustomRoutineTime('');
        } catch (error) { console.error("루틴 추가 오류:", error); }
    };

    const handleToggleTodaysRoutineCompletion = async (routine, isNowChecked) => {
        if (!db || !userId) return;
        const { id: routineId, completedDays } = routine;
        const wasCompletedToday = !!completedDays?.[todayDateString];
        try {
            await updateDoc(doc(db, firebasePaths.customRoutineDoc(userId, routineId)), { [`completedDays.${todayDateString}`]: isNowChecked });
            if (isNowChecked && !wasCompletedToday) { await updateStudentProfile(db, userId, { skills: { "자기 주도 학습 능력": 10, "책임감": 5 } }, userId); }
        } catch (error) { console.error("루틴 완료 토글 오류:", error); }
    };

    const handleDayToggle = (day) => { setNewCustomRoutineDays(p => p.includes(day) ? p.filter(d => d !== day) : [...p, day]); };
    const radarChartData = Object.entries(skills).map(([skill, value]) => ({ skill, A: value, fullMark: 100 }));

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-100 to-indigo-200 p-4 sm:p-6 md:p-8 text-gray-800 font-sans">
            <header className="mb-8 text-center"><h1 className="text-4xl sm:text-5xl font-extrabold text-indigo-700 mb-2">AI 온맞춤 나의 성장 대시보드</h1><p className="text-lg sm:text-xl text-indigo-600">환영합니다, {displayName}님!</p><p className="text-sm text-gray-600 mt-2">사용자 ID: <span className="font-mono bg-gray-200 px-2 py-1 rounded">{userId || '익명'}</span></p></header>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <section className="bg-white p-6 rounded-2xl shadow-lg border border-green-200 col-span-full"><h2 className="text-2xl font-bold text-green-800 mb-4 text-center">나의 성장 캐릭터와 역량</h2><div className="flex flex-col md:flex-row items-center justify-around gap-6"><div className="flex flex-col items-center"><div className="w-32 h-32 bg-gray-200 rounded-full flex items-center justify-center text-5xl mb-3 text-green-600 border-4 border-green-400">🌱</div><p className="text-2xl font-bold">레벨: {level}</p><p className="text-lg">XP: {characterXP} / {level * 100}</p><div className="w-48 bg-gray-200 rounded-full h-3 mt-2"><div className="bg-green-500 h-3 rounded-full" style={{ width: `${(characterXP / (level * 100)) * 100}%` }}></div></div><p className="text-2xl font-bold text-yellow-500 mt-4">💰 {gold} 골드</p></div><div className="w-full md:w-2/3 h-80"><ResponsiveContainer width="100%" height="100%"><RadarChart cx="50%" cy="50%" outerRadius="80%" data={radarChartData}><PolarGrid /><PolarAngleAxis dataKey="skill" /><PolarRadiusAxis angle={90} domain={[0, 100]} /><Radar name="역량" dataKey="A" stroke="#8884d8" fill="#8884d8" fillOpacity={0.6} /></RadarChart></ResponsiveContainer></div></div></section>
                <section className="bg-white p-6 rounded-2xl shadow-lg border border-blue-200 col-span-full lg:col-span-1"><h2 className="text-2xl font-bold text-indigo-800 mb-4">AI 온맞춤 루틴</h2><button onClick={handleGenerateDailyMissions} className={`w-full mb-4 px-5 py-3 rounded-lg text-lg font-semibold shadow-md transition-colors ${isGeneratingMissions ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`} disabled={isGeneratingMissions}>{isGeneratingMissions ? '✨ 미션 생성 중...' : '오늘의 미션 생성 ✨'}</button><ul className="space-y-3 max-h-96 overflow-y-auto">{dailyMissions.length > 0 ? dailyMissions.map((m) => (<li key={m.id} className="bg-blue-50 p-3 rounded-lg shadow-sm"><div className="font-bold">{m.title} <span className="text-sm font-medium text-indigo-600">({m.type})</span></div><p className="text-sm text-gray-700">{m.description}</p><div className="flex justify-between items-center mt-2"><span className="text-sm">XP: {m.rewardXp} | 골드: {m.rewardGold}</span>{m.isCompleted ? <span className="text-green-600 font-bold">✅ 완료</span> : m.isPendingApproval ? <span className="text-yellow-600 font-bold">⏳ 승인 대기</span> : <button onClick={() => handleStudentRequestMissionCompletion(m.id)} className="px-3 py-1 bg-indigo-500 text-white rounded-lg text-sm">완료 요청</button>}</div></li>)) : <p className="text-gray-600 text-center">미션을 생성해주세요.</p>}</ul></section>
                <section className="bg-white p-6 rounded-2xl shadow-lg border border-teal-200 col-span-full lg:col-span-1"><h2 className="text-2xl font-bold text-teal-800 mb-4">나만의 루틴 설계</h2><div className="space-y-3 mb-4"><input type="text" className="w-full p-2 border rounded-lg" placeholder="활동 내용" value={newCustomRoutineTitle} onChange={(e) => setNewCustomRoutineTitle(e.target.value)} /><div className="flex flex-wrap gap-2 text-sm">{allDays.map(d => (<label key={d} className="flex items-center"><input type="checkbox" value={d} checked={newCustomRoutineDays.includes(d)} onChange={() => handleDayToggle(d)} className="mr-1" />{d}</label>))}</div><input type="text" className="w-full p-2 border rounded-lg" placeholder="시간 (예: 오후 3시)" value={newCustomRoutineTime} onChange={(e) => setNewCustomRoutineTime(e.target.value)} /><button onClick={handleAddCustomRoutine} className="w-full p-3 bg-teal-600 text-white rounded-lg font-semibold">루틴 추가</button></div><ul className="space-y-3 max-h-60 overflow-y-auto">{customRoutines.length > 0 ? customRoutines.map((r) => { const isToday = r.days.includes(dayOfWeek); const isDone = !!r.completedDays?.[todayDateString]; return (<li key={r.id} className="bg-teal-50 p-3 rounded-lg flex items-center">{isToday ? (<input type="checkbox" id={`c-${r.id}`} className="w-5 h-5 mr-3 shrink-0" checked={isDone} onChange={(e) => handleToggleTodaysRoutineCompletion(r, e.target.checked)} />) : (<div className="w-5 h-5 mr-3 shrink-0" />)}<label htmlFor={`c-${r.id}`} className={`flex-1 ${isDone ? 'line-through text-gray-500' : ''}`}><span className="font-medium">{r.title}</span><span className="block text-sm text-gray-600">{r.days.join(', ')} {r.time}</span></label></li>);}) : <p className="text-gray-600 text-center">나만의 루틴을 추가해보세요.</p>}</ul></section>
                <section className="bg-white p-6 rounded-2xl shadow-lg border border-purple-200 col-span-full lg:col-span-1"><h2 className="text-2xl font-bold text-purple-800 mb-4">AI 성장일지</h2><textarea className="w-full h-28 p-3 border rounded-lg mb-4" placeholder="오늘 배운 점, 느낀 점을 기록해보세요!" value={journalEntry} onChange={(e) => setJournalEntry(e.target.value)}></textarea><button onClick={handleJournalSubmit} className={`w-full p-3 rounded-lg font-semibold ${isGeneratingFeedback || isGeneratingQuestions ? 'bg-purple-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700 text-white'}`} disabled={isGeneratingFeedback || isGeneratingQuestions}>{isGeneratingFeedback || isGeneratingQuestions ? '✨ 생성 중...' : '성장일지 기록하기 ✨'}</button><div className="mt-4 space-y-4 max-h-60 overflow-y-auto">{growthJournalEntries.length > 0 ? growthJournalEntries.map((e) => (<div key={e.id} className="bg-purple-50 p-3 rounded-lg"><p className="text-sm text-gray-500">{new Date(e.timestamp).toLocaleString()}</p><p className="font-medium">{e.content}</p>{e.aiFeedback && <p className="text-purple-700 text-sm italic border-l-2 border-purple-400 pl-2 mt-1">AI 피드백: {e.aiFeedback}</p>}</div>)) : <p className="text-gray-600 text-center">첫 일지를 기록해보세요!</p>}</div></section>
                {generatedQuestions.length > 0 && (<section className="bg-white p-6 rounded-2xl shadow-lg border border-orange-200 col-span-full"><h2 className="text-2xl font-bold text-orange-800 mb-4">AI 학습 문제</h2><div className="space-y-6">{generatedQuestions.map((q, i) => (<div key={q.id || i} className="bg-orange-50 p-4 rounded-lg"><p className="font-bold text-lg mb-2">Q{i + 1}. {q.questionText}</p>{q.type === "객관식" && q.options?.map((opt, oi) => (<label key={oi} className="flex items-center"><input type="radio" name={`q-${q.id}`} value={opt} onChange={(e) => setStudentAnswers(p => ({ ...p, [q.id]: e.target.value }))} className="mr-2" disabled={!!questionResults[q.id]} />{opt}</label>))}{q.type === "단답형" && <input type="text" className="w-full p-2 border rounded-lg" onChange={(e) => setStudentAnswers(p => ({ ...p, [q.id]: e.target.value }))} disabled={!!questionResults[q.id]} />}<button onClick={() => handleAnswerSubmission(q.id, studentAnswers[q.id] || '', q.correctAnswer, q.explanation)} className={`px-4 py-2 mt-2 rounded-lg text-sm font-semibold ${!studentAnswers[q.id] || !!questionResults[q.id] ? 'bg-gray-400 cursor-not-allowed' : 'bg-orange-600 text-white hover:bg-orange-700'}`} disabled={!studentAnswers[q.id] || !!questionResults[q.id]}>제출</button>{questionResults[q.id] && (<div className={`mt-2 p-2 rounded-lg ${questionResults[q.id].isCorrect ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}><p className="font-bold">{questionResults[q.id].feedback}</p><p>해설: {questionResults[q.id].explanation}</p></div>)}</div>))}</div></section>)}
            </div>
        </div>
    );
};

// Teacher Dashboard Component - UPGRADED
const TeacherDashboard = () => {
    const { db, userId, isAuthInitialized } = useFirebase();
    const [studentsData, setStudentsData] = useState([]);
    const [studentsMissions, setStudentsMissions] = useState({});
    const [displayName, setDisplayName] = useState('교사');
    const [loading, setLoading] = useState(true);
    
    // State for new features
    const [activeTab, setActiveTab] = useState('analysis'); // 'analysis' or 'management'
    const [analysisResults, setAnalysisResults] = useState({}); // { studentId: result }
    const [generatingAnalysisId, setGeneratingAnalysisId] = useState(null);
    const [analysisPeriod, setAnalysisPeriod] = useState('weekly'); // 'weekly' or 'monthly'
    
    const [newStudentName, setNewStudentName] = useState('');
    const [newStudentPassword, setNewStudentPassword] = useState('');
    const [isAddingStudent, setIsAddingStudent] = useState(false);
    const [studentToDelete, setStudentToDelete] = useState(null); // {id, name}

    useEffect(() => {
        if (!db || !userId || !isAuthInitialized) return;
        setLoading(true);
        const unsubTeacher = onSnapshot(doc(db, firebasePaths.userProfile(userId)), (d) => { if (d.exists()) setDisplayName(d.data().displayName || '교사'); });
        
        const studentsQuery = query(collection(db, `artifacts/${appId}/public/data/teacherViewableStudentProfiles`));
        const unsubStudents = onSnapshot(studentsQuery, (s) => { 
            const firestoreStudents = s.docs.map(doc => ({ 
                id: doc.id, 
                ...doc.data(),
                fromFirestore: true
            }));

            const allStudentNames = Object.keys(studentAccounts);

            const mergedStudents = allStudentNames.map(name => {
                const existingStudent = firestoreStudents.find(fs => fs.displayName === name);
                
                if (existingStudent) {
                    return existingStudent;
                } else {
                    return {
                        id: `placeholder_${name}`,
                        displayName: name,
                        level: 0,
                        xp: 0,
                        gold: 0,
                        skills: {},
                        fromFirestore: false,
                        isDeleted: false,
                    };
                }
            });
            
            const activeStudents = mergedStudents.filter(student => !student.isDeleted);
            setStudentsData(activeStudents); 

        }, (e) => console.error("학생 데이터 가져오기 오류:", e));

        const unsubMissions = onSnapshot(collection(db, firebasePaths.missions()), (s) => {
            const missionsByStudent = s.docs.map(d => ({ id: d.id, ...d.data() })).reduce((acc, m) => {
                if (!acc[m.studentId]) acc[m.studentId] = [];
                acc[m.studentId].push(m);
                return acc;
            }, {});
            setStudentsMissions(missionsByStudent);
            setLoading(false); 
        }, (e) => { console.error("모든 미션 가져오기 오류:", e); setLoading(false); });
        return () => { unsubTeacher(); unsubStudents(); unsubMissions(); };
    }, [db, userId, isAuthInitialized]);

    const handleTeacherMissionToggle = async (studentId, mission, isCompleted) => {
        if (!db) return;
        const { id: missionId } = mission;
        const missionDocRef = doc(db, firebasePaths.missionDoc(missionId));
        try {
            await updateDoc(missionDocRef, {
                isCompleted: !isCompleted,
                isPendingApproval: false,
                completedAt: !isCompleted ? serverTimestamp() : null,
            });
        } catch (error) { 
            console.error("미션 상태 토글 오류:", error); 
        }
    };

    const handleGenerateAnalysis = async (student) => {
        setGeneratingAnalysisId(student.id);
        setAnalysisResults(prev => ({ ...prev, [student.id]: null }));
        try {
            const studentMissions = studentsMissions[student.id] || [];
            const completedMissionCount = studentMissions.filter(m => m.isCompleted).length;
            const skillsSummary = Object.entries(student.skills || {}).map(([key, value]) => `${key}: ${value}점`).join(', ');
            const periodText = analysisPeriod === 'weekly' ? '주간' : '월간';

            const prompt = `
                너는 초등학교 3학년 학생의 ${periodText} 학습 데이터를 분석하고 2022 개정 교육과정에 기반하여 교사를 위한 리포트를 작성하는 교육 AI 전문가야.
                아래 데이터를 바탕으로 학생의 학습 상태를 분석하고, 필요한 경우 맞춤형 보충 미션을 제안해줘.

                **학생 정보:**
                - 이름: ${student.displayName} - 레벨: ${student.level} - 완료한 미션 수: ${completedMissionCount}개 - 현재 역량 점수: ${skillsSummary}

                **요청:**
                1. **summary**: 학생의 이번 ${periodText} 학습 활동을 2~3문장으로 요약해줘.
                2. **strength**: 가장 점수가 높거나 활동이 많았던 역량을 2022 개정 교육과정의 성취 기준과 연결하여 학생의 강점을 분석해줘.
                3. **weakness**: 가장 점수가 낮거나 활동이 부족했던 역량을 2022 개정 교육과정의 성취 기준과 연결하여 보완이 필요한 점을 분석해줘.
                4. **alert**: 만약 특정 역량 점수가 10점 미만으로 매우 낮다면, "학습 부진 경고" 메시지를 생성해줘. (예: "${student.displayName} 학생은 특히 '수리력(세 자리 수의 덧셈)' 영역에서 어려움을 겪고 있는 것으로 보입니다.") 그렇지 않으면 이 항목은 비워둬.
                5. **recommendedMissions**: 'alert'이 생성된 경우에만, 해당 역량을 보완할 수 있는 초등학교 3학년 수준의 맞춤형 보충 미션 2개를 2022 개정 교육과정에 맞춰 생성해줘. 예를 들어 '수리력'이 부족하다면 '가게 놀이를 하며 세 자리 수 덧셈 문제 5개 풀기' 와 같이 구체적이고 재미있는 활동으로 제안해줘. 미션은 title, type, description, rewardXp, rewardGold를 포함해야 해.
            `;

            const result = await callGeminiAPIStructured(prompt, analysisSchema);
            if (result) {
                setAnalysisResults(prev => ({ ...prev, [student.id]: result }));
            } else {
                throw new Error("AI 분석 리포트 생성 실패");
            }
        } catch (error) {
            console.error("AI 분석 생성 중 오류 발생:", error);
            setAnalysisResults(prev => ({ ...prev, [student.id]: { summary: "리포트 생성 중 오류가 발생했습니다. 다시 시도해주세요." } }));
        } finally {
            setGeneratingAnalysisId(null);
        }
    };
    
    const handleAddRecommendedMissions = async (studentId, missions) => {
        if (!db || !missions || missions.length === 0) return;
        const batch = writeBatch(db);
        const missionsCollectionRef = collection(db, firebasePaths.missions());
        
        missions.forEach(mission => {
            const newMissionRef = doc(missionsCollectionRef);
            batch.set(newMissionRef, {
                ...mission,
                studentId: studentId,
                generatedAt: serverTimestamp(),
                isCompleted: false,
                isPendingApproval: false,
                isStudentRewarded: false,
                isRecommended: true,
            });
        });

        try {
            await batch.commit();
            const currentResult = analysisResults[studentId];
            setAnalysisResults(prev => ({
                ...prev,
                [studentId]: { ...currentResult, recommendedMissions: null }
            }));
        } catch (error) {
            console.error("추천 미션 추가 중 오류 발생:", error);
        }
    };

    const handleAddStudent = async (e) => {
        e.preventDefault();
        if (!newStudentName.trim() || !newStudentPassword.trim()) {
            alert("학생 이름과 초기 비밀번호를 모두 입력해주세요.");
            return;
        }
        setIsAddingStudent(true);
        try {
            const newStudentId = `student_${Date.now()}`;
            const initialSkills = { "문해력": 0, "수리력": 0, "창의력": 0, "책임감": 0, "문제 해결 능력": 0, "자기 주도 학습 능력": 0 };
            const studentProfileData = {
                userId: newStudentId,
                role: 'student',
                displayName: newStudentName,
                xp: 0, gold: 0, level: 1, skills: initialSkills,
                createdAt: serverTimestamp(),
                isDeleted: false,
            };
            
            await setDoc(doc(db, firebasePaths.publicStudentProfile(newStudentId)), studentProfileData);
            
            studentAccounts[newStudentName] = newStudentPassword;

            setNewStudentName('');
            setNewStudentPassword('');
        } catch (error) {
            console.error("학생 추가 중 오류 발생:", error);
        } finally {
            setIsAddingStudent(false);
        }
    };

    const handleDeleteStudent = async () => {
        if (!studentToDelete) return;
        const { id: studentId, name: studentName } = studentToDelete;
        
        try {
            const publicProfileRef = doc(db, firebasePaths.publicStudentProfile(studentId));
            await updateDoc(publicProfileRef, {
                isDeleted: true
            });
            
            delete studentAccounts[studentName];

        } catch (error) {
            console.error(`Error hiding student ${studentName}:`, error);
        } finally {
            setStudentToDelete(null);
        }
    };


    if (loading) { return <div className="flex justify-center items-center h-screen"><p>학생 정보 로딩 중...</p></div>; }

    return (
        <div className="min-h-screen bg-gradient-to-br from-red-100 to-orange-200 p-6 sm:p-8">
            <header className="mb-8 text-center"><h1 className="text-4xl sm:text-5xl font-extrabold text-red-700">교사 대시보드</h1><p className="text-lg text-red-600">환영합니다, {displayName}님!</p></header>
            
            <div className="mb-6 border-b-2 border-gray-300 flex">
                <button onClick={() => setActiveTab('analysis')} className={`px-6 py-3 text-lg font-semibold ${activeTab === 'analysis' ? 'border-b-4 border-purple-600 text-purple-700' : 'text-gray-500'}`}>학생 성장 분석</button>
                <button onClick={() => setActiveTab('management')} className={`px-6 py-3 text-lg font-semibold ${activeTab === 'management' ? 'border-b-4 border-blue-600 text-blue-700' : 'text-gray-500'}`}>학생 관리</button>
            </div>

            {activeTab === 'analysis' && (
                <section id="analysis-tab">
                    <div className="bg-white p-6 rounded-2xl shadow-lg">
                        <h2 className="text-2xl font-bold text-red-800 mb-4">학생 학습 현황</h2>
                        {studentsData.length > 0 ? (
                            <div className="grid grid-cols-1 gap-6">
                                {studentsData.map(student => (
                                    <div key={student.id} className="bg-red-50 p-4 rounded-lg shadow-sm">
                                        <h3 className="text-2xl font-semibold text-red-700">{student.displayName}</h3>
                                        {student.fromFirestore ? (
                                            <>
                                                <div className="flex flex-wrap gap-x-4 mb-4 text-sm"><span>레벨: {student.level}</span><span>XP: {student.xp}</span><span>골드: {student.gold}</span></div>
                                                <h4 className="text-xl font-bold text-red-600 mb-2">오늘의 미션</h4>
                                                {studentsMissions[student.id]?.length > 0 ? (<ul className="space-y-2 mb-4">{studentsMissions[student.id].map(m => (<li key={m.id} className={`p-2 rounded-lg flex items-center ${m.isPendingApproval ? 'bg-yellow-100' : 'bg-white'}`}><input type="checkbox" className="w-5 h-5 mr-3" checked={m.isCompleted} onChange={() => handleTeacherMissionToggle(student.id, m, m.isCompleted)} /><label className="flex-1"><span className="font-medium">{m.title}</span>{m.isPendingApproval && <span className="text-xs font-bold text-yellow-800 ml-2">승인 요청!</span>}</label></li>))}</ul>) : <p className="text-gray-600 text-sm mb-4">미션이 없습니다.</p>}
                                                <div className="mt-4 pt-4 border-t border-red-200">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <select value={analysisPeriod} onChange={(e) => setAnalysisPeriod(e.target.value)} className="p-2 border rounded-lg">
                                                            <option value="weekly">주간</option>
                                                            <option value="monthly">월간</option>
                                                        </select>
                                                        <button onClick={() => handleGenerateAnalysis(student)} disabled={generatingAnalysisId === student.id} className={`px-4 py-2 rounded-lg text-white font-semibold shadow-md transition-colors ${generatingAnalysisId === student.id ? 'bg-gray-400' : 'bg-purple-600 hover:bg-purple-700'}`}>
                                                            {generatingAnalysisId === student.id ? '분석 중...' : `📈 AI ${analysisPeriod === 'weekly' ? '주간' : '월간'} 리포트 생성`}
                                                        </button>
                                                    </div>
                                                    {generatingAnalysisId === student.id && <p className="text-sm text-purple-700 mt-2">AI가 학생 데이터를 분석하고 있습니다...</p>}
                                                    {analysisResults[student.id] && (
                                                        <div className="mt-4 space-y-3 bg-purple-50 p-3 rounded-lg">
                                                            <h4 className="font-bold text-purple-800 text-lg">AI 학습 리포트 ({analysisPeriod === 'weekly' ? '주간' : '월간'})</h4>
                                                            {analysisResults[student.id].alert && <div className="bg-yellow-200 p-2 rounded-md text-yellow-800 font-bold">🚨 {analysisResults[student.id].alert}</div>}
                                                            <p><strong className="text-purple-700">종합 요약:</strong> {analysisResults[student.id].summary}</p>
                                                            <p><strong className="text-green-700">👍 강점:</strong> {analysisResults[student.id].strength}</p>
                                                            <p><strong className="text-orange-700">🤔 보완점:</strong> {analysisResults[student.id].weakness}</p>
                                                            {analysisResults[student.id].recommendedMissions && (
                                                                <div className="mt-3 pt-3 border-t border-purple-200">
                                                                    <h5 className="font-bold text-purple-800">💡 AI 추천 맞춤 미션</h5>
                                                                    <ul className="list-disc list-inside text-sm mt-1">
                                                                        {analysisResults[student.id].recommendedMissions.map((m, i) => <li key={i}><strong>{m.title}</strong>: {m.description}</li>)}
                                                                    </ul>
                                                                    <button onClick={() => handleAddRecommendedMissions(student.id, analysisResults[student.id].recommendedMissions)} className="mt-2 px-3 py-1 bg-green-500 text-white text-sm font-semibold rounded-md hover:bg-green-600">이 미션들 추가하기</button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        ) : (
                                            <p className="text-gray-500 text-sm mt-2">아직 활동 기록이 없습니다.</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : <p className="text-gray-600">등록된 학생이 없습니다.</p>}
                    </div>
                </section>
            )}

            {activeTab === 'management' && (
                <section id="management-tab">
                    <div className="bg-white p-6 rounded-2xl shadow-lg mb-8">
                        <h2 className="text-2xl font-bold text-blue-800 mb-4">신규 학생 추가</h2>
                        <form onSubmit={handleAddStudent} className="bg-blue-50 p-4 rounded-lg space-y-3">
                            <input type="text" value={newStudentName} onChange={(e) => setNewStudentName(e.target.value)} placeholder="학생 이름" className="w-full p-2 border rounded-lg" required/>
                            <input type="text" value={newStudentPassword} onChange={(e) => setNewStudentPassword(e.target.value)} placeholder="초기 비밀번호" className="w-full p-2 border rounded-lg" required/>
                            <button type="submit" disabled={isAddingStudent} className={`w-full px-4 py-2 rounded-lg text-white font-semibold shadow-md transition-colors ${isAddingStudent ? 'bg-gray-400' : 'bg-blue-500 hover:bg-blue-600'}`}>
                                {isAddingStudent ? '추가하는 중...' : '학생 추가하기'}
                            </button>
                        </form>
                    </div>
                    <div className="bg-white p-6 rounded-2xl shadow-lg">
                        <h2 className="text-2xl font-bold text-red-800 mb-4">등록된 학생 목록</h2>
                        <div className="space-y-2">
                            {studentsData.map(student => (
                                <div key={student.id} className="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
                                    <span className="font-medium">{student.displayName}</span>
                                    <button 
                                        onClick={() => setStudentToDelete({id: student.id, name: student.displayName})} 
                                        className={`px-3 py-1 text-sm font-semibold rounded-md transition-colors ${student.fromFirestore ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
                                        disabled={!student.fromFirestore}
                                    >
                                        삭제
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            )}

            {studentToDelete && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white p-6 rounded-lg shadow-xl text-center">
                        <h3 className="text-lg font-bold mb-4">정말로 '{studentToDelete.name}' 학생을 목록에서 숨기시겠습니까?</h3>
                        <p className="text-sm text-gray-600 mb-6">이 작업은 되돌릴 수 없습니다. 학생의 프로필이 대시보드에서 보이지 않게 됩니다.</p>
                        <div className="flex justify-center gap-4">
                            <button onClick={() => setStudentToDelete(null)} className="px-4 py-2 bg-gray-300 rounded-lg">취소</button>
                            <button onClick={handleDeleteStudent} className="px-4 py-2 bg-red-600 text-white rounded-lg">숨기기 확인</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// Login Screen Component
const LoginScreen = () => {
    const { login, loading } = useFirebase();
    const [id, setId] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const handleSubmit = async (e) => { e.preventDefault(); setError(''); const res = await login(id, password); if (!res.success) { setError(res.error || "로그인 오류"); } };
    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-200 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
                <h2 className="text-3xl font-extrabold text-center text-indigo-700 mb-6">로그인</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <input type="text" placeholder="아이디" className="w-full p-3 border rounded-lg" value={id} onChange={(e) => setId(e.target.value)} required />
                    <input type="password" placeholder="비밀번호" className="w-full p-3 border rounded-lg" value={password} onChange={(e) => setPassword(e.target.value)} required />
                    {error && <p className="text-red-500 text-sm text-center">{error}</p>}
                    <button type="submit" className={`w-full p-3 rounded-lg text-lg font-semibold ${loading ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`} disabled={loading}>{loading ? '로그인 중...' : '로그인'}</button>
                </form>
            </div>
        </div>
    );
};

// Main App Content Component
const MainAppContent = () => {
    const { userRole, loading, logout, isAuthInitialized } = useFirebase();
    if (loading || !isAuthInitialized) { return <div className="flex justify-center items-center h-screen"><p>앱 로딩 중...</p></div>; }
    if (!userRole) { return <LoginScreen />; }
    return (
        <div className="relative">
            <div className="absolute top-4 right-4 z-10"><button onClick={logout} className="px-4 py-2 bg-red-500 text-white rounded-lg shadow-md hover:bg-red-600">로그아웃</button></div>
            {userRole === 'teacher' ? <TeacherDashboard /> : <StudentDashboard />}
        </div>
    );
}

// Main App Component
export default function App() {
    return (
        <FirebaseProvider>
            <MainAppContent />
        </FirebaseProvider>
    );
}
