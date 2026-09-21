export default async function handler(request) {
  const headers = {"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
  const url = new URL(request.url);
  const username = String(url.searchParams.get("username") || "").trim();
  if (!username) return new Response(JSON.stringify({error:"Informe o usuário do Roblox."}),{status:400,headers});
  if (username.length > 40) return new Response(JSON.stringify({error:"Usuário inválido."}),{status:400,headers});
  try {
    const userResponse = await fetch("https://users.roblox.com/v1/usernames/users",{
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({usernames:[username],excludeBannedUsers:false})
    });
    const userRaw=await userResponse.text(); let userData={};
    try{userData=JSON.parse(userRaw)}catch{return new Response(JSON.stringify({error:"O Roblox retornou uma resposta inválida."}),{status:502,headers})}
    if(!userResponse.ok)return new Response(JSON.stringify({error:"O Roblox não respondeu corretamente."}),{status:502,headers});
    const user=userData?.data?.[0];
    if(!user)return new Response(JSON.stringify({error:"Usuário do Roblox não encontrado."}),{status:404,headers});
    const thumbUrl="https://thumbnails.roblox.com/v1/users/avatar-headshot"+`?userIds=${encodeURIComponent(user.id)}&size=150x150&format=Png&isCircular=false`;
    const thumbResponse=await fetch(thumbUrl,{headers:{"Accept":"application/json"}});
    const thumbRaw=await thumbResponse.text(); let thumbData={}; try{thumbData=JSON.parse(thumbRaw)}catch{}
    return new Response(JSON.stringify({id:user.id,name:user.name,displayName:user.displayName,avatarUrl:thumbData?.data?.[0]?.imageUrl||""}),{status:200,headers});
  } catch {
    return new Response(JSON.stringify({error:"Não foi possível consultar o Roblox agora."}),{status:502,headers});
  }
}
