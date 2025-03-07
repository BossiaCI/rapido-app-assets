import { screenHeight, screenWidth } from "@/utils/Constants";
import { StyleSheet } from "react-native";

export const splashStyles = StyleSheet.create({
    img: {
        width: screenWidth * 0.4,
        height: screenHeight * 0.4,
        resizeMode: 'contain'
    },
    text: {
        position: "absolute",
        bottom: 40,
    }
})