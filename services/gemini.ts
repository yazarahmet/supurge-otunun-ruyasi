import { GoogleGenAI, Type, Modality } from "@google/genai";
import { DreamAnalysis } from "../types";

// API Key kontrolü
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.warn("UYARI: API Key bulunamadı! Vercel Environment Variables ayarlarını kontrol edin.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "DUMMY_KEY_FOR_BUILD" });

// Yardımcı Fonksiyon: JSON Ayıklayıcı
// Model bazen markdown, bazen düz metin, bazen de bozuk JSON dönebilir.
// Bu fonksiyon metnin içinden geçerli JSON objesini bulmaya çalışır.
function extractJSON(text: string): any {
  try {
    // 1. Temizle
    let cleanText = text.replace(/```json|```/g, '').trim();
    
    // 2. Doğrudan parse dene
    return JSON.parse(cleanText);
  } catch (e) {
    // 3. Eğer başarısız olursa, süslü parantezlerin arasını bulmaya çalış
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose !== -1) {
      const candidate = text.substring(firstOpen, lastClose + 1);
      try {
        return JSON.parse(candidate);
      } catch (e2) {
        // Yine başarısız
      }
    }
    throw new Error("JSON formatı algılanamadı.");
  }
}

// Yardımcı: Timeout'lu Fetch
// API çağrısı sonsuza kadar asılı kalmasın diye wrapper.
async function withTimeout<T>(promise: Promise<T>, ms: number = 60000): Promise<T> {
    let timer: any;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("İstek zaman aşımına uğradı (Timeout). İnternet bağlantınızı kontrol edin.")), ms);
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

// 1. Transcribe Audio (Speech to Text)
export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  const base64Audio = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.split(',')[1]; // Data URL header'ını kaldır
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
            {
            inlineData: {
                mimeType: mimeType,
                data: base64Audio
            }
            },
            {
            text: "Lütfen bu ses dosyasını tam olarak metne dök. Sadece söylenenleri yaz, yorum yapma."
            }
        ]
        }
    }));
    return response.text || "";
  } catch (error: any) {
    console.error("Transcribe Error:", error);
    throw new Error(`Ses işlenirken hata: ${error.message || error}`);
  }
};

// 2. Analyze Dream (Text Interpretation)
export const analyzeDreamText = async (dreamText: string): Promise<DreamAnalysis> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  try {
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Aşağıdaki rüyayı detaylı bir şekilde tabir et. 
        Rüya: "${dreamText}"
        
        Yanıtı MÜMKÜNSE şu JSON formatında ver (değilse düz metin olarak yorumla):
        {
        "sentiment": "positive" veya "negative" (genel hava),
        "title": "Rüyaya kısa başlık",
        "interpretation": "Detaylı yorum"
        }`,
        config: {
        // responseMimeType: "application/json", // Model bazen zorlanıyor, serbest bırakıyoruz.
        responseSchema: {
            type: Type.OBJECT,
            properties: {
            sentiment: { type: Type.STRING, enum: ["positive", "negative", "neutral"] },
            title: { type: Type.STRING },
            interpretation: { type: Type.STRING }
            }
        }
        }
    }));

    const rawText = response.text || "";
    
    try {
        // JSON denemesi
        const data = extractJSON(rawText);
        // Eksik alan varsa tamamla
        if (!data.interpretation) data.interpretation = rawText;
        if (!data.title) data.title = "Rüya Tabiri";
        if (!data.sentiment) data.sentiment = "neutral";
        return data as DreamAnalysis;

    } catch (jsonError) {
        // JSON parse edilemediyse "Fallback" modu:
        // Uygulamanın patlamasını engellemek için ham metni yorum olarak dönüyoruz.
        console.warn("JSON parse hatası, raw text kullanılıyor:", jsonError);
        
        return {
            sentiment: 'neutral',
            title: 'Rüya Yorumu',
            interpretation: rawText.replace(/```json|```/g, '').trim() // Markdown temizle
        };
    }

  } catch (error: any) {
    console.error("Analysis Error:", error);
    throw new Error(`Rüya tabir edilirken hata: ${error.message || "Bilinmeyen hata"}`);
  }
};

// 3. Generate Image
export const generateDreamImage = async (dreamText: string, sentiment: string): Promise<string> => {
  if (!apiKey) return "";

  const moodPrompt = sentiment === 'positive' 
    ? "divine light, ethereal, soft pastel colors, dreamlike, masterpiece" 
    : "mysterious, dark fog, gothic, deep shadows, dreamlike, masterpiece";

  const prompt = `Surrealist oil painting: ${dreamText}. Style: ${moodPrompt}`;

  try {
    const response = await withTimeout(ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }]
      }
    }), 45000); // Görsel için 45sn timeout

    // Yanıtı tara
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    return "";
  } catch (e) {
    console.error("Image generation failed", e);
    return ""; // Sessizce başarısız ol, akışı bozma
  }
};

// 4. Text to Speech
export const generateDreamSpeech = async (text: string): Promise<{ audioData: Float32Array, sampleRate: number }> => {
  if (!apiKey) throw new Error("API Anahtarı eksik.");

  // Metin çok uzunsa kırp (TTS limitlerine takılmamak için)
  const safeText = text.length > 500 ? text.substring(0, 500) + "..." : text;

  const response = await withTimeout(ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: safeText }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  }));

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("Ses verisi alınamadı.");

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

  return {
    audioData: float32,
    sampleRate: 24000
  };
};

// 5. Keyword Chat
export const askKeywordQuestion = async (
  dreamText: string, 
  interpretation: string, 
  question: string,
  history: {role: string, parts: {text: string}[]}[]
): Promise<string> => {
  
  const systemInstruction = `Sen Süpürge Otu adında rüya tabircisisin. Rüya: "${dreamText}". Tabir: "${interpretation}". Soruya kısa ve mistik cevap ver.`;

  // Geçmişi doğru formatta hazırla (Gemini SDK formatı)
  // History verisi ChatSession başlatılırken verilir.
  
  try {
    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: { systemInstruction },
        history: history.map(h => ({
            role: h.role,
            parts: h.parts,
        }))
    });

    const result = await withTimeout(chat.sendMessage({ message: question }));
    return result.text || "Sessizlik...";
  } catch (e) {
      console.error("Chat error:", e);
      return "Şu an cevap veremiyorum.";
  }
};
