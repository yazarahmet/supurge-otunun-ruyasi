import { GoogleGenAI, Type, Modality } from "@google/genai";
import { DreamAnalysis } from "../types";

// API Key kontrolü
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.warn("UYARI: API Key bulunamadı! Vercel Environment Variables ayarlarını kontrol edin.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "DUMMY_KEY_FOR_BUILD" });

// Güvenlik Ayarları: İçerik filtrelerine takılmamak için
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// Yardımcı Fonksiyon: JSON Ayıklayıcı
function extractJSON(text: string): any {
  try {
    let cleanText = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (e) {
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      const candidate = text.substring(firstOpen, lastClose + 1);
      try {
        return JSON.parse(candidate);
      } catch (e2) {}
    }
    throw new Error("JSON formatı algılanamadı.");
  }
}

// Yardımcı: TTS için metni temizle (Markdown vb. kaldır)
function cleanTextForTTS(text: string): string {
  return text
    .replace(/[*_~`]/g, '') // Markdown sembollerini kaldır
    .replace(/\[.*?\]/g, '') // Linkleri kaldır
    .replace(/^\s*[-+*]\s+/gm, '') // Liste işaretlerini kaldır
    .replace(/#{1,6}\s+/g, '') // Başlık işaretlerini kaldır
    .trim();
}

// Yardımcı: Timeout'lu Fetch
async function withTimeout<T>(promise: Promise<T>, ms: number = 60000): Promise<T> {
    let timer: any;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("İstek zaman aşımına uğradı.")), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timer);
        return result;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

// 1. Transcribe Audio
export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  const base64Audio = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(audioBlob);
  });

  const mimeType = audioBlob.type || 'audio/webm';

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
        parts: [
            { inlineData: { mimeType: mimeType, data: base64Audio } },
            { text: "Lütfen bu ses dosyasını tam olarak metne dök. Sadece söylenenleri yaz." }
        ]
        }
    }));
    return response.text || "";
  } catch (error: any) {
    console.error("Transcribe Error:", error);
    throw new Error(`Ses işlenirken hata: ${error.message || error}`);
  }
};

// 2. Analyze Dream
export const analyzeDreamText = async (dreamText: string): Promise<DreamAnalysis> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Aşağıdaki rüyayı detaylı bir şekilde tabir et. 
        Rüya: "${dreamText}"
        
        Yanıtı MÜMKÜNSE şu JSON formatında ver:
        {
        "sentiment": "positive" veya "negative" veya "neutral",
        "title": "Rüyaya kısa başlık",
        "interpretation": "Detaylı yorum"
        }`,
        config: {
        responseSchema: {
            type: Type.OBJECT,
            properties: {
            sentiment: { type: Type.STRING, enum: ["positive", "negative", "neutral"] },
            title: { type: Type.STRING },
            interpretation: { type: Type.STRING }
            }
        },
        safetySettings: SAFETY_SETTINGS
        }
    }));

    const rawText = response.text || "";
    try {
        const data = extractJSON(rawText);
        if (!data.interpretation) data.interpretation = rawText;
        if (!data.title) data.title = "Rüya Tabiri";
        if (!data.sentiment) data.sentiment = "neutral";
        return data as DreamAnalysis;
    } catch (jsonError) {
        return {
            sentiment: 'neutral',
            title: 'Rüya Yorumu',
            interpretation: rawText.replace(/```json|```/g, '').trim()
        };
    }
  } catch (error: any) {
    throw new Error(`Rüya tabir edilirken hata: ${error.message}`);
  }
};

// 3. Generate Image
export const generateDreamImage = async (dreamText: string, sentiment: string): Promise<string> => {
  if (!apiKey) return "";

  const safeText = dreamText.length > 100 ? dreamText.substring(0, 100) : dreamText;
  const mood = sentiment === 'positive' ? "mystical bright" : "dark surreal";
  const prompt = `Surreal art: ${safeText}. ${mood}.`;

  // Retry logic: 1 kez tekrar dene
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
        const response = await withTimeout(ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ text: prompt }] },
            config: {
                safetySettings: SAFETY_SETTINGS // Güvenlik filtresi takılmasını önle
            }
        }), 45000);

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                return `data:image/png;base64,${part.inlineData.data}`;
            }
        }
    } catch (e: any) {
        console.error(`Image gen attempt ${attempt + 1} failed:`, e);
        if (attempt === 1) return ""; // Son deneme de başarısızsa boş dön
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1sn bekle tekrar dene
    }
  }
  return "";
};

// 4. Text to Speech
export const generateDreamSpeech = async (text: string): Promise<{ audioData: Float32Array, sampleRate: number }> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  // Metni temizle ve kısalt
  const cleanText = cleanTextForTTS(text);
  const safeText = cleanText.length > 4000 ? cleanText.substring(0, 4000) : cleanText;

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: safeText }] }],
        config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, // Kore veya Puck deneyebiliriz
            },
        },
        safetySettings: SAFETY_SETTINGS
        },
    }), 60000); // TTS biraz daha uzun sürebilir

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("API'den ses verisi dönmedi (Boş yanıt).");

    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    const buffer = bytes.buffer;
    const pcm16 = new Int16Array(buffer, 0, Math.floor(bytes.length / 2));
    const float32 = new Float32Array(pcm16.length);
    
    for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
    }

    // Eğer ses verisi çok kısaysa (örn: hata sesi veya boşluk) hata fırlat
    if (float32.length < 100) throw new Error("Ses verisi çok kısa/boş.");

    return {
        audioData: float32,
        sampleRate: 24000
    };
  } catch (e) {
      console.error("TTS Generation Failed:", e);
      throw e;
  }
};

// 5. Keyword Chat
export const askKeywordQuestion = async (
  dreamText: string, 
  interpretation: string, 
  question: string,
  history: {role: string, parts: {text: string}[]}[]
): Promise<string> => {
  
  const systemInstruction = `Sen Süpürge Otu adında rüya tabircisisin. Rüya: "${dreamText}". Tabir: "${interpretation}". Soruya kısa ve mistik cevap ver.`;

  try {
    const chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: { systemInstruction, safetySettings: SAFETY_SETTINGS },
      history: history as any
    });

    const response = await withTimeout(chat.sendMessage({ message: question }));
    return response.text || "Ruhlar sessiz...";
  } catch (e) {
      return "Bir hata oluştu.";
  }
};
