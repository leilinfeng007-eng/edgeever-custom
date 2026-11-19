import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "../../i18n/resources/zh-CN.ts";
import { CompanionRunDetails } from "./CompanionRunDetails.tsx";

test("tool progress is collapsed with readable operation names, errors and real note receipts",async()=>{
  const i18n=createInstance();await i18n.init({lng:"zh-CN",resources:{"zh-CN":{translation:zhCN}}});
  const html=renderToStaticMarkup(createElement(I18nextProvider,{i18n},createElement(CompanionRunDetails,{turn:{status:"completed",todos:[{id:"one",content:"读取材料",status:"completed"}],tools:[
    {id:"read",name:"read_memo_attachment",status:"error",effects:[],error:"Unsupported attachment format"},
    {id:"write",name:"update_memo",status:"done",effects:[{kind:"updated",memoId:"memo_saved",title:"测试笔记"}]},
  ]}})));
  expect(html).toContain("读取附件内容");expect(html).toContain("1 步失败");
  expect(html).toContain("Unsupported attachment format");expect(html).toContain("#memo=memo_saved");
  expect(html).not.toContain(' open=""');expect(html).not.toContain("read_memo_attachment");
});
