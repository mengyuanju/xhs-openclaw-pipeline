只返回一个 JSON 对象，字段必须为：
name, type, generationTarget, promptTemplate, negativePrompt, styleTags, categories, layoutRules, qualityScore。
type 必须是 PHOTO_HERO、STEP_GUIDE、CHECKLIST、COMPARISON、TIMELINE、TRAVEL_GUIDE、EMOTION_STORY、PRODUCT_DISPLAY 之一。
generationTarget 必须是 MODEL_IMAGE 或 LOCAL_CARD。
promptTemplate 可以使用 {{query}}、{{category}}、{{targetAudience}}、{{imageIndex}}、{{imageCount}}；不得使用其他变量。
qualityScore 为 1 到 5 的数字。layoutRules 必须是普通 JSON 对象。