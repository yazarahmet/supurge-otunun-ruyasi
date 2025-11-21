import React, { useState, useRef, useEffect } from 'react';
import { AppStatus, DreamAnalysis, ChatMessage, AudioData } from './types';
import { transcribeAudio, analyzeDreamText, generateDreamImage, generateDreamSpeech, askKeywordQuestion, splitTextForTTS } from './services/gemini';
import { MicIcon, StopIcon, PlayIcon, PauseIcon, SendIcon, SparklesIcon, ImageIcon } from './components/Icons';

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [dreamText, setDreamText] = useState('');
  const [analysis, setAnalysis] = useState<DreamAnalysis | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState('');
  
  // Audio State
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [currentAudioIndex, setCurrentAudioIndex] = useState(0); // Hangi paragraftayız

  // Audio Recording Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Playback Audio Refs (Complex Queue System)
  const playbackAudioCtxRef = useRef<AudioContext | null>(null);
  const activeAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  
  // Paragraf metinlerini tutar
  const textChunksRef = useRef<string[]>([]);
  // İndirilen ses verilerini index bazlı saklar (Cache)
  const audioCacheMapRef = useRef<Map<number, AudioData>>(new Map());
  // O an indirilmekte olan istekleri saklar (Promise Cache) - Çifte isteği önler
  const pendingAudioRequestsRef = useRef<Map<number, Promise<AudioData>>>(new Map());

  // Scroll refs
  const resultRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // UI Theming based on sentiment
  const getTheme = () => {
    if (!analysis) return 'bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white';
    
    if (analysis.sentiment === 'positive') {
      return 'bg-gradient-to-br from-teal-50 via-emerald-100 to-cyan-100 text-emerald-900 transition-colors duration-1000 ease-in-out';
    } else {
      return 'bg-gradient-to-br from-gray-900 via-slate-800 to-stone-900 text-stone-300 transition-colors duration-1000 ease-in-out';
    }
  };

  const getCardStyle = () => {
     if (!analysis) return 'bg-white/10 border-white/20';
     if (analysis.sentiment === 'positive') return 'bg-white/60 border-emerald-200 shadow-emerald-100/50 text-emerald-900';
     return 'bg-black/40 border-stone-700 shadow-black/50 text-stone-200';
  };

  const getButtonStyle = () => {
      if (!analysis || analysis.sentiment === 'negative') return 'bg-purple-600 hover:bg-purple-500 text-white';
      return 'bg-emerald-600 hover:bg-emerald-500 text-white';
  };

  // --- Audio Queue Helpers ---

  // Belirli bir indeksteki parçayı getir (Yoksa indir)
  const fetchAudioChunk = async (index: number): Promise<AudioData> => {
    // 1. Cache'de varsa döndür
    if (audioCacheMapRef.current.has(index)) {
      return audioCacheMapRef.current.get(index)!;
    }

    // 2. Zaten iniyorsa o promise'i döndür
    if (pendingAudioRequestsRef.current.has(index)) {
      return pendingAudioRequestsRef.current.get(index)!;
    }

    // 3. Metin bitmişse hata fırlatma, boş dön (Safety)
    if (index >= textChunksRef.current.length) {
        throw new Error("Index out of bounds");
    }

    // 4. İndirmeyi başlat
    console.log(`Ses parçası indiriliyor: ${index + 1}/${textChunksRef.current.length}`);
    const promise = generateDreamSpeech(textChunksRef.current[index])
      .then(data => {
        audioCacheMapRef.current.set(index, data);
        pendingAudioRequestsRef.current.delete(index);
        return data;
      })
      .catch(err => {
        pendingAudioRequestsRef.current.delete(index);
        throw err;
      });
    
    pendingAudioRequestsRef.current.set(index, promise);
    return promise;
  };

  const stopAudio = () => {
    if (activeAudioSourceRef.current) {
      try { activeAudioSourceRef.current.stop(); } catch (e) {}
      activeAudioSourceRef.current = null;
    }
    setIsPlayingAudio(false);
    setIsLoadingAudio(false);
  };

  const playAudioSequence = async (startIndex: number) => {
    if (startIndex >= textChunksRef.current.length) {
      setIsPlayingAudio(false);
      setCurrentAudioIndex(0); // Başa sar
      return;
    }

    setIsLoadingAudio(true);
    setCurrentAudioIndex(startIndex);

    try {
      // Audio Context Hazırlığı
      if (!playbackAudioCtxRef.current || playbackAudioCtxRef.current.state === 'closed') {
         playbackAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = playbackAudioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      // Şu anki parçayı al
      const audioData = await fetchAudioChunk(startIndex);

      // BİR SONRAKİ parçayı şimdiden indirmeye başla (Pre-fetch)
      if (startIndex + 1 < textChunksRef.current.length) {
        fetchAudioChunk(startIndex + 1).catch(e => console.warn("Prefetch failed", e));
      }

      // Oynatma hazırlığı
      const buffer = ctx.createBuffer(1, audioData.audioData.length, audioData.sampleRate);
      buffer.getChannelData(0).set(audioData.audioData);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      activeAudioSourceRef.current = source;
      
      setIsLoadingAudio(false);
      setIsPlayingAudio(true); // UI: Oynatılıyor ikonuna dön

      source.onended = () => {
        // Eğer kullanıcı manuel durdurmadıysa sıradakine geç
        if (activeAudioSourceRef.current === source) { // Eski source kontrolü (Race condition önlemi)
             // React state update'i ve bir sonraki çağrı arasında küçük bir boşluk olabilir, sorun değil.
             playAudioSequence(startIndex + 1);
        }
      };
      
      source.start(0);

    } catch (e) {
      console.error("Oynatma hatası:", e);
      setIsLoadingAudio(false);
      setIsPlayingAudio(false);
      // Bir hata olduysa bir sonrakini denemesin, dursun.
    }
  };

  // --- Main Handlers ---

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await handleTranscription(audioBlob);
      };

      mediaRecorderRef.current.start();
      setStatus(AppStatus.RECORDING);
    } catch (err) {
      console.error("Mikrofon hatası:", err);
      alert("Mikrofon izni gerekli.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setStatus(AppStatus.TRANSCRIBING);
    }
  };

  const handleTranscription = async (blob: Blob) => {
    try {
      const text = await transcribeAudio(blob);
      setDreamText(text);
      setStatus(AppStatus.IDLE);
    } catch (error: any) {
      console.error(error);
      setStatus(AppStatus.ERROR);
      alert("Hata: " + (error.message || "Bilinmeyen bir hata oluştu."));
    }
  };

  const processDream = async () => {
    if (!dreamText.trim()) return;
    
    setStatus(AppStatus.ANALYZING);
    setAnalysis(null);
    setImageUrl(null);
    setChatMessages([]);
    
    // Reset audio states
    stopAudio();
    audioCacheMapRef.current.clear();
    pendingAudioRequestsRef.current.clear();
    textChunksRef.current = [];
    setCurrentAudioIndex(0);

    try {
      // 1. Analyze Text (Şimdi imagePrompt da dönüyor)
      const analysisResult = await analyzeDreamText(dreamText);
      setAnalysis(analysisResult);

      // FIX: Uzun metinleri TTS için parçalara böl
      if (analysisResult.interpretation) {
         const chunks = splitTextForTTS(analysisResult.interpretation);
         textChunksRef.current = chunks;
         console.log(`TTS için metin ${chunks.length} parçaya bölündü.`);

         // İlk parçayı hemen arka planda hazırlamaya başla
         if (chunks.length > 0) {
             fetchAudioChunk(0).catch(e => console.warn("Arka plan ilk parça hazırlığı başarısız:", e));
         }
      }

      // 2. Generate Image (İngilizce prompt kullanıyoruz artık)
      setStatus(AppStatus.GENERATING_IMAGE);
      try {
        // Eğer analizden imagePrompt geldiyse onu kullan, yoksa title'ı kullan (Fallback)
        const promptToUse = analysisResult.imagePrompt || analysisResult.title || dreamText.substring(0, 50);
        const img = await generateDreamImage(promptToUse);
        setImageUrl(img);
      } catch (imgError) {
        console.warn("Görsel oluşturma hatası (sessizce geçildi):", imgError);
      }

      setStatus(AppStatus.COMPLETE);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

    } catch (error: any) {
      console.error(error);
      setStatus(AppStatus.IDLE); 
      alert("Hata: " + (error.message || "Bir hata oluştu. Lütfen tekrar deneyiniz."));
    }
  };

  const toggleAudioPlayback = async () => {
    if (!analysis || textChunksRef.current.length === 0) return;

    if (isPlayingAudio || isLoadingAudio) {
        // Durdur
        stopAudio();
    } else {
        // Kaldığı yerden veya baştan başlat
        // Eğer son parçada bitmişse (current >= length) başa (0) al.
        let startIndex = currentAudioIndex;
        if (startIndex >= textChunksRef.current.length) {
            startIndex = 0;
        }
        playAudioSequence(startIndex);
    }
  };

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentQuestion.trim() || !analysis) return;

    const newUserMsg: ChatMessage = { role: 'user', text: currentQuestion };
    setChatMessages(prev => [...prev, newUserMsg]);
    const question = currentQuestion;
    setCurrentQuestion('');

    const apiHistory = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
    }));

    try {
        const answer = await askKeywordQuestion(dreamText, analysis.interpretation, question, apiHistory);
        setChatMessages(prev => [...prev, { role: 'model', text: answer }]);
    } catch (error) {
        setChatMessages(prev => [...prev, { role: 'model', text: "Üzgünüm, şu an cevap veremiyorum." }]);
    }
  };

  useEffect(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Component unmount temizliği
  useEffect(() => {
      return () => {
          stopAudio();
          if (playbackAudioCtxRef.current) {
              playbackAudioCtxRef.current.close();
          }
      }
  }, []);

  return (
    <div className={`min-h-screen flex flex-col font-sans selection:bg-purple-500 selection:text-white ${getTheme()}`}>
      
      <header className="p-6 text-center relative z-10">
        <h1 className="text-4xl md:text-6xl font-serif font-bold tracking-widest drop-shadow-lg">
          Süpürge Otu'nun Rüyası
        </h1>
        <p className="mt-2 text-lg opacity-80 font-light tracking-wide">
          Bilinçaltının derinliklerine mistik bir yolculuk
        </p>
      </header>

      <main className="flex-grow container mx-auto px-4 pb-10 max-w-3xl relative z-10">
        
        <div className={`backdrop-blur-md rounded-3xl shadow-xl p-6 mb-8 border transition-all duration-500 ${getCardStyle()}`}>
          <div className="relative">
            <textarea
              value={dreamText}
              onChange={(e) => setDreamText(e.target.value)}
              placeholder="Rüyanı buraya yaz veya mikrofonu kullanarak anlat..."
              className={`w-full h-40 p-4 rounded-xl bg-transparent border-2 focus:outline-none focus:ring-2 resize-none text-lg placeholder-opacity-50 ${
                 analysis?.sentiment === 'positive' 
                 ? 'border-emerald-300/50 focus:border-emerald-500 placeholder-emerald-700/50' 
                 : 'border-stone-600/50 focus:border-purple-500 placeholder-stone-500'
              }`}
            />
            
            <div className="flex items-center justify-between mt-4">
               <button
                onClick={status === AppStatus.RECORDING ? stopRecording : startRecording}
                className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all ${
                  status === AppStatus.RECORDING 
                    ? 'bg-red-500 animate-pulse text-white' 
                    : 'bg-transparent border border-current opacity-70 hover:opacity-100'
                }`}
              >
                {status === AppStatus.RECORDING ? <StopIcon className="w-5 h-5" /> : <MicIcon className="w-5 h-5" />}
                <span className="text-sm font-bold">{status === AppStatus.RECORDING ? 'Durdur' : 'Ses Kaydı'}</span>
              </button>

              <button
                onClick={processDream}
                disabled={!dreamText || status === AppStatus.ANALYZING || status === AppStatus.GENERATING_IMAGE}
                className={`flex items-center gap-2 px-8 py-3 rounded-full font-bold text-lg shadow-lg transform hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${getButtonStyle()}`}
              >
                {status === AppStatus.ANALYZING || status === AppStatus.GENERATING_IMAGE ? (
                  <>
                    <SparklesIcon className="w-5 h-5 animate-spin" />
                    <span>Tabir Ediliyor...</span>
                  </>
                ) : (
                  <>
                    <SparklesIcon className="w-5 h-5" />
                    <span>Rüyayı Tabir Et</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {status === AppStatus.TRANSCRIBING && (
          <div className="text-center py-4 animate-pulse">Ses metne dönüştürülüyor...</div>
        )}

        {(analysis || status === AppStatus.GENERATING_IMAGE || status === AppStatus.COMPLETE) && (
          <div ref={resultRef} className="space-y-8 animate-fade-in-up">
            
            <div className="relative aspect-video md:aspect-[16/9] rounded-2xl overflow-hidden shadow-2xl border-4 border-opacity-20 border-white group">
              {imageUrl ? (
                <img src={imageUrl} alt="Rüya Görseli" className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700" />
              ) : (
                <div className="w-full h-full bg-black/20 flex flex-col items-center justify-center backdrop-blur-sm">
                   <ImageIcon className="w-16 h-16 opacity-50 animate-bounce" />
                   <p className="mt-4 font-serif italic">
                     {status === AppStatus.GENERATING_IMAGE ? "Rüyanız görselleştiriliyor..." : "Görsel oluşturulamadı (İsteğe bağlı)."}
                   </p>
                </div>
              )}
              {analysis?.title && (
                 <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-6 pt-20">
                    <h2 className="text-3xl font-serif text-white font-bold">{analysis.title}</h2>
                 </div>
              )}
            </div>

            {analysis && (
              <div className={`backdrop-blur-md rounded-3xl p-8 shadow-xl border ${getCardStyle()}`}>
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-xl font-serif font-bold uppercase tracking-widest opacity-80">Tabir</h3>
                  <div className="flex items-center gap-2">
                    {/* İlerleme Göstergesi */}
                    {(isPlayingAudio || isLoadingAudio) && textChunksRef.current.length > 1 && (
                        <span className="text-xs opacity-60 font-mono">
                            {currentAudioIndex + 1} / {textChunksRef.current.length}
                        </span>
                    )}
                    <button 
                        onClick={toggleAudioPlayback}
                        className={`p-3 rounded-full hover:bg-white/20 transition-colors ${isPlayingAudio ? 'text-red-400 ring-2 ring-red-400/30' : (isLoadingAudio ? 'opacity-50' : 'text-green-400')}`}
                        title={isPlayingAudio ? "Durdur" : "Sesli Dinle"}
                    >
                        {isLoadingAudio ? (
                            <SparklesIcon className="w-8 h-8 animate-spin" />
                        ) : isPlayingAudio ? (
                            <PauseIcon className="w-8 h-8" />
                        ) : (
                            <PlayIcon className="w-8 h-8" />
                        )}
                    </button>
                  </div>
                </div>
                <p className="text-lg leading-relaxed font-serif text-justify whitespace-pre-wrap">
                  {analysis.interpretation}
                </p>
              </div>
            )}

            {analysis && (
              <div className={`backdrop-blur-md rounded-3xl p-6 shadow-xl border mt-8 ${getCardStyle()}`}>
                <div className="border-b border-current border-opacity-20 pb-4 mb-4">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <span className="text-2xl">🔮</span> Rüya Sembolleri Sohbeti
                  </h3>
                  <p className="text-sm opacity-70 mt-1">
                    Rüyanızdaki belirli sembolleri (örn: "yılan", "uçmak", "deniz") sorarak derinlemesine anlamını öğrenin.
                  </p>
                </div>
                
                <div className="h-64 overflow-y-auto mb-4 space-y-4 pr-2 scroll-smooth">
                  {chatMessages.length === 0 && (
                     <div className="text-center opacity-50 italic mt-20">
                        "Rüyamda gördüğüm anahtar ne anlama geliyor?"
                     </div>
                  )}
                  {chatMessages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                        msg.role === 'user' 
                          ? 'bg-white/20 text-current rounded-tr-none' 
                          : 'bg-black/20 text-current rounded-tl-none'
                      }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                <form onSubmit={handleChatSubmit} className="relative">
                  <input
                    type="text"
                    value={currentQuestion}
                    onChange={(e) => setCurrentQuestion(e.target.value)}
                    placeholder="Bir sembol sor..."
                    className="w-full py-3 px-5 pr-12 rounded-full bg-white/10 border border-white/20 focus:outline-none focus:bg-white/20 transition-all placeholder-current placeholder-opacity-40"
                  />
                  <button 
                    type="submit"
                    disabled={!currentQuestion.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/20 disabled:opacity-30 transition-colors"
                  >
                    <SendIcon className="w-5 h-5" />
                  </button>
                </form>
              </div>
            )}

          </div>
        )}
      </main>

      <div className="fixed top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className={`absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full mix-blend-overlay filter blur-[100px] animate-float ${analysis?.sentiment === 'positive' ? 'bg-emerald-400/30' : 'bg-purple-900/40'}`}></div>
        <div className={`absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full mix-blend-overlay filter blur-[100px] animate-float animation-delay-2000 ${analysis?.sentiment === 'positive' ? 'bg-cyan-300/30' : 'bg-indigo-900/40'}`}></div>
      </div>

    </div>
  );
};

export default App;
