/** Only inspect the instruction line, not quoted note contents. */
export const companionAdviceOnly = (message: string) =>
  /(?:先(?:给|提供|说|提).{0,8}(?:建议|方案)|只(?:给|提供).{0,8}(?:建议|方案)|不要(?:直接)?(?:修改|保存|写入|移动|删除)|暂不(?:修改|保存|写入|执行)|仅(?:分析|讨论)|advice only|suggestions only|do not (?:edit|save|write|move|delete)|don't (?:edit|save|write|move|delete))/iu
    .test(message.trim().split(/\n/, 1)[0].slice(0, 250));
