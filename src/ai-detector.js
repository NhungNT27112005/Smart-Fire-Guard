// Biến lưu thời gian giữ trạng thái báo động (debounce)
let fireHoldTime = 0;
const HOLD_DURATION = 10000; // Giữ báo động 10000 mili-giây (10 giây) sau khi AI mất dấu lửa

exports.analyzeFrame = async function(imageData) {
    if (!imageData) {
        return { hasFire: false, confidence: 0, statusText: 'AI Detection: ⏳ Đang chờ hình ảnh...' };
    }

    try {
        const response = await fetch('http://127.0.0.1:5000/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageData })
        });

        const result = await response.json();
        
        let finalHasFire = result.hasFire;
        let displayConf = result.confidence;

        // --- LOGIC CHỐNG NHIỄU GIẬT CỤC ---
        if (result.hasFire) {
            // Nhìn thấy lửa -> Cập nhật mốc thời gian báo động mới nhất
            fireHoldTime = Date.now() + HOLD_DURATION;
        } else if (Date.now() < fireHoldTime) {
            // AI không thấy lửa, nhưng vẫn đang trong thời gian 5 giây đếm ngược -> Ép bật cảnh báo
            finalHasFire = true;
            displayConf = "Đang duy trì"; 
        }

        return {
            hasFire: finalHasFire,
            confidence: displayConf,
            statusText: finalHasFire 
                ? `🔥 AI Detection: Phát hiện nguy cơ! (${displayConf}${typeof displayConf === 'number' ? '%' : ''})` 
                : `✓ AI Detection: An toàn`
        };
    } catch (error) {
        console.error("[AI Error] Lỗi kết nối tới Python Server:", error.message);
        return { hasFire: false, confidence: 0, statusText: '⚠️ AI Detection: Mất kết nối AI Server' };
    }
};