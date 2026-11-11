import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import React,{useEffect,useState} from "react";
import {Alert,FlatList,KeyboardAvoidingView,Platform,Pressable,SafeAreaView,StyleSheet,Text,TextInput,View} from "react-native";
import Purchases,{CustomerInfo,LOG_LEVEL} from "react-native-purchases";
import {RevenueCatUI} from "react-native-purchases-ui";

const API=(Constants.expoConfig?.extra?.apiUrl||"http://localhost:3000").replace(/\/$/,"");
const RC=Constants.expoConfig?.extra;
const ENTITLEMENT=RC?.revenueCatEntitlement||"pro_access";

async function api(path:string,opts:any={}){
  const r=await fetch(API+path,{...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}});
  const d=r.status===204?null:await r.json(); if(!r.ok)throw Error(d?.error||"Request failed"); return d;
}
async function setSession(access:string,refresh:string){await SecureStore.setItemAsync("accessToken",access);await SecureStore.setItemAsync("refreshToken",refresh)}
async function clearSession(){await SecureStore.deleteItemAsync("accessToken");await SecureStore.deleteItemAsync("refreshToken")}
async function getAccess(){return SecureStore.getItemAsync("accessToken")}

export default function App(){
 const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[auth,setAuth]=useState(false),[mode,setMode]=useState<"login"|"signup">("login");
 const [conversation,setConversation]=useState<any>(null),[messages,setMessages]=useState<any[]>([]),[text,setText]=useState(""),[busy,setBusy]=useState(false),[pro,setPro]=useState(false);

 useEffect(()=>{(async()=>{const a=await getAccess();if(a){setAuth(true);await initPurchases();}})()},[]);
 async function initPurchases(){
   try{
     Purchases.setLogLevel(LOG_LEVEL.WARN);
     if(Platform.OS==="ios") await Purchases.configure({apiKey:RC?.revenueCatAppleApiKey});
     else if(Platform.OS==="android") await Purchases.configure({apiKey:RC?.revenueCatGoogleApiKey});
     const info=await Purchases.getCustomerInfo(); setPro(!!info.entitlements.active[ENTITLEMENT]);
   }catch(e){console.log("Purchases init",e)}
 }
 async function authenticate(){
  try{
   const d=await api("/api/auth/"+mode,{method:"POST",body:JSON.stringify({email,password})});
   await setSession(d.accessToken,d.refreshToken);setAuth(true);await initPurchases();
  }catch(e:any){Alert.alert("Sign in failed",e.message)}
 }
 async function authorized(path:string,opts:any={}){
  const access=await getAccess();
  return api(path,{...opts,headers:{...(opts.headers||{}),Authorization:"Bearer "+access}});
 }
 async function newChat(){try{const d=await authorized("/api/conversations",{method:"POST"});setConversation(d.conversation);setMessages([])}catch(e:any){Alert.alert("Error",e.message)}}
 async function send(){const v=text.trim();if(!v||!conversation||busy)return;setText("");setBusy(true);setMessages(m=>[...m,{role:"user",content:v}]);
  try{const d=await authorized("/api/conversations/"+conversation.id+"/messages",{method:"POST",body:JSON.stringify({content:v})});setMessages(m=>[...m,{role:"assistant",content:d.text}])}
  catch(e:any){Alert.alert("Message failed",e.message)}finally{setBusy(false)}
 }
 async function manage(){try{await RevenueCatUI.presentCustomerCenter()}catch(e:any){Alert.alert("Subscriptions","Customer Center is unavailable until the RevenueCat project is configured.")}}
 if(!auth)return <SafeAreaView style={s.auth}><Text style={s.logo}>MOMO</Text><Text style={s.sub}>Private AI assistance.</Text>
  <TextInput style={s.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}/>
  <TextInput style={s.input} placeholder="Password (12+ characters)" secureTextEntry value={password} onChangeText={setPassword}/>
  <Pressable style={s.button} onPress={authenticate}><Text style={s.buttonText}>{mode==="login"?"Sign in":"Create account"}</Text></Pressable>
  <Pressable onPress={()=>setMode(mode==="login"?"signup":"login")}><Text style={s.link}>{mode==="login"?"Create an account":"I already have an account"}</Text></Pressable>
 </SafeAreaView>;
 return <SafeAreaView style={s.app}><View style={s.header}><Text style={s.title}>{conversation?.title||"MOMO"}</Text>
  <View style={{flexDirection:"row",gap:14}}><Pressable onPress={manage}><Text style={s.link}>{pro?"Manage":"Pro"}</Text></Pressable><Pressable onPress={newChat}><Text style={s.link}>New</Text></Pressable></View></View>
  {!conversation?<View style={s.empty}><Text style={s.h2}>Start a conversation</Text><Pressable style={s.button} onPress={newChat}><Text style={s.buttonText}>New chat</Text></Pressable></View>:
  <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}><FlatList data={messages} keyExtractor={(_,i)=>String(i)} contentContainerStyle={s.list} renderItem={({item})=><View style={[s.bubble,item.role==="user"?s.user:s.assistant]}><Text>{item.content}</Text></View>}/>
  <View style={s.composer}><TextInput style={s.chatInput} multiline value={text} onChangeText={setText} placeholder="Message…"/><Pressable style={s.send} onPress={send} disabled={busy}><Text style={s.buttonText}>Send</Text></Pressable></View></KeyboardAvoidingView>}
 </SafeAreaView>
}
const s=StyleSheet.create({app:{flex:1,backgroundColor:"#fff"},auth:{flex:1,padding:24,justifyContent:"center",backgroundColor:"#fff"},logo:{fontSize:32,fontWeight:"700",marginBottom:8},sub:{color:"#666",marginBottom:24},input:{borderWidth:1,borderColor:"#ddd",borderRadius:12,padding:14,marginBottom:12},button:{backgroundColor:"#111",borderRadius:12,padding:14,alignItems:"center",marginBottom:12},buttonText:{color:"#fff",fontWeight:"600"},link:{color:"#2563eb",padding:8},header:{height:58,borderBottomWidth:1,borderBottomColor:"#eee",paddingHorizontal:18,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},title:{fontSize:18,fontWeight:"600"},empty:{flex:1,alignItems:"center",justifyContent:"center"},h2:{fontSize:22,fontWeight:"600",marginBottom:16},list:{padding:18,gap:12},bubble:{padding:13,borderRadius:16,maxWidth:"82%"},user:{alignSelf:"flex-end",backgroundColor:"#eee"},assistant:{alignSelf:"flex-start",backgroundColor:"#f7f7f7"},composer:{flexDirection:"row",padding:10,borderTopWidth:1,borderTopColor:"#eee",alignItems:"flex-end"},chatInput:{flex:1,maxHeight:120,padding:10},send:{backgroundColor:"#111",borderRadius:18,paddingHorizontal:15,paddingVertical:10}});
