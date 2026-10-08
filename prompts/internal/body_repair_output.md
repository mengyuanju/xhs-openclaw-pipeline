仅返回 {"body":"修订后完整正文"}，其他字段由程序保留。正文有效范围400～600，必须以完整句子收尾；不得通过截断达到字数要求。

程序实测字数与本次修复预算：{{slot1}}。
有 lengthBudget 时，以 currentLength 为实际字数，将正文修订到 targetMin～targetMax；超长时至少减少 requiredReduction 个字符，过短时至少补充 requiredExpansion 个字符。英文字母、数字、标点、空格和换行均逐个计数，不按英文单词计数。continuedCompression 非空时，在最新完整正文上继续压缩，不重复原稿；只处理正文，保留核心结论、事实、命令、必要步骤和风险边界，不新增事实。
